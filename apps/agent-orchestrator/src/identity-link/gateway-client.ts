/**
 * Thin client for apps/integration-gateway's internal identity-link API
 * (src/identity-link/api.ts, backed by GithubDeviceFlowLinker) -- the
 * mirror-image counterpart of apps/integration-gateway/src/orchestrator-client.ts
 * (that one is gateway-calling-orchestrator; this one is orchestrator-calling-
 * gateway), styled the same way: bearer-authed, fetch-based, injectable
 * `fetchImpl` for tests.
 *
 * Lets `delegateToAgent`/`checkPendingIdentityLink` (agent/graph.ts) start a
 * one-time OAuth Device Flow for a caller who hasn't linked their GitHub
 * identity yet, poll it to completion, and fetch the caller's current
 * (transparently refreshed) token once linked.
 */
export interface IdentityLinkStart {
  flow: "device";
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

/** The authcode-flow counterpart of `IdentityLinkStart` -- no device code, nothing to poll: the caller resolves via `getToken` once the browser redirect completes. */
export interface IdentityLinkAuthCodeStart {
  flow: "authcode";
  authorizeUrl: string;
  expiresInSeconds: number;
}

/**
 * The `claude` provider's flow (docs/adr/0027) -- a PTY-driven `setup-token`
 * session, not an HTTP device/authcode exchange, so there's no device code to
 * poll and no separate browser-redirect callback: the caller (delegateToAgent)
 * just shows `pageUrl` and resolves via `getToken`/`waitForCompletion` once
 * the user has pasted the code into that page, same as the authcode flow.
 */
export interface IdentityLinkPageStart {
  flow: "page";
  pageUrl: string;
  expiresInSeconds: number;
}

/** Discriminated by `flow`, matching the gateway's `/identity-link/:provider/start` (or claude-auth's equivalent) response shape. */
export type IdentityLinkStartResult = IdentityLinkStart | IdentityLinkAuthCodeStart | IdentityLinkPageStart;

export type IdentityLinkPollStatus = "pending" | "complete" | "expired" | "denied";

export interface IdentityLinkToken {
  token: string;
  /** GitHub-specific; absent for other providers (e.g. `claude`, docs/adr/0027) which have no equivalent concept. Never read outside display/logging. */
  githubLogin?: string;
}

export interface IdentityLinkPort {
  start(provider: string, subject: string, flow: "device" | "authcode"): Promise<IdentityLinkStartResult>;
  /** Only ever called for a `"device"`-flow pending link (see graph.ts's `checkPendingIdentityLink`) -- a provider whose `start` never returns `flow: "device"` need not meaningfully implement this. */
  poll(provider: string, subject: string, deviceCode: string): Promise<IdentityLinkPollStatus>;
  /** Returns `undefined` when nothing is linked yet for this (provider, subject) -- a 404, not an error. */
  getToken(provider: string, subject: string): Promise<IdentityLinkToken | undefined>;
  /**
   * Blocks (via the gateway's own Redis-backed wait, not local polling) until
   * a token lands for (provider, subject), or resolves `undefined` once
   * `timeoutMs` elapses -- lets a streaming caller hold its connection open
   * across an authcode browser round-trip instead of requiring a follow-up
   * chat message. Optional: callers fall back to the original
   * wait-for-the-next-message behavior when a `IdentityLinkPort` doesn't
   * implement it (e.g. existing test doubles).
   */
  waitForCompletion?(provider: string, subject: string, timeoutMs: number): Promise<IdentityLinkToken | undefined>;
  /**
   * Invalidates a subject's stored link (docs/adr/0027's re-auth path):
   * called when a delegated agent run reports its credential as
   * expired/invalid mid-run, so the NEXT delegation attempt's `getToken`
   * finds nothing and starts a fresh link instead of repeating a bad token
   * forever. Optional -- GitHub's own token refresh (`getValidToken` on the
   * gateway side) already handles GitHub's version of this, so
   * `IdentityLinkGatewayClient` doesn't need to implement it.
   */
  invalidate?(provider: string, subject: string): Promise<void>;
}

export interface IdentityLinkGatewayClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class IdentityLinkGatewayClient implements IdentityLinkPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IdentityLinkGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(provider: string, subject: string, flow: "device" | "authcode"): Promise<IdentityLinkStartResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/identity-link/${provider}/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({ subject, flow }),
    });
    if (!res.ok) {
      throw new Error(`identity-link start (${provider}) failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as IdentityLinkStartResult;
  }

  async poll(provider: string, subject: string, deviceCode: string): Promise<IdentityLinkPollStatus> {
    const res = await this.fetchImpl(`${this.baseUrl}/identity-link/${provider}/poll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({ subject, deviceCode }),
    });
    if (!res.ok) {
      throw new Error(`identity-link poll (${provider}) failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { status: IdentityLinkPollStatus };
    return body.status;
  }

  /**
   * A 404 here means "nothing linked yet" -- an expected, non-exceptional
   * outcome (the caller has simply never completed the device flow), unlike
   * start/poll's non-2xx handling above.
   */
  async getToken(provider: string, subject: string): Promise<IdentityLinkToken | undefined> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/identity-link/${provider}/token?subject=${encodeURIComponent(subject)}`,
      { headers: { authorization: `Bearer ${this.options.token}` } },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`identity-link token lookup (${provider}) failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as IdentityLinkToken;
  }

  /**
   * A long-held `fetch` -- the gateway itself blocks on this request (up to
   * `timeoutMs`) rather than us polling it repeatedly. No AbortSignal is set
   * here: the gateway's own response is the authoritative deadline.
   */
  async waitForCompletion(provider: string, subject: string, timeoutMs: number): Promise<IdentityLinkToken | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/identity-link/${provider}/wait`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify({ subject, timeoutMs }),
    });
    if (!res.ok) {
      throw new Error(`identity-link wait (${provider}) failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { status: "complete" | "timeout"; token?: IdentityLinkToken };
    return body.status === "complete" ? body.token : undefined;
  }
}
