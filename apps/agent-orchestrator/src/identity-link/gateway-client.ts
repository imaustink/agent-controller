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

/** Discriminated by `flow`, matching the gateway's `/identity-link/:provider/start` response shape. */
export type IdentityLinkStartResult = IdentityLinkStart | IdentityLinkAuthCodeStart;

export type IdentityLinkPollStatus = "pending" | "complete" | "expired" | "denied";

export interface IdentityLinkToken {
  token: string;
  githubLogin: string;
}

export interface IdentityLinkPort {
  start(provider: string, subject: string, flow: "device" | "authcode"): Promise<IdentityLinkStartResult>;
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
