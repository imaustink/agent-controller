import type { IdentityLinkPageStart, IdentityLinkPollStatus, IdentityLinkPort, IdentityLinkStartResult, IdentityLinkToken } from "./gateway-client.js";

/**
 * Thin client for apps/integration-gateway's internal claude-auth API
 * (src/claude-auth/api.ts, backed by `ClaudeSetupTokenFlows` -- docs/adr/0027)
 * -- the `claude`-provider counterpart of `IdentityLinkGatewayClient`, kept as
 * a separate class (different base path, different flow shape: a PTY-driven
 * `setup-token` session instead of GitHub's HTTP device/authcode exchange)
 * but implementing the SAME `IdentityLinkPort` interface graph.ts already
 * depends on, via the `"page"` flow variant -- so `delegateToAgent`/
 * `checkPendingIdentityLink` need only branch on WHICH gateway client to
 * call for a given provider (see graph.ts's `identityGatewayFor`), not
 * duplicate their own start/wait/resume logic per provider.
 */
export interface ClaudeAuthGatewayClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class ClaudeAuthGatewayClient implements IdentityLinkPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClaudeAuthGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `flow` is ignored -- this provider only ever has one flow shape (the PTY-driven page). Kept in the signature to satisfy `IdentityLinkPort`. */
  async start(_provider: string, subject: string): Promise<IdentityLinkStartResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify({ subject }),
    });
    if (!res.ok) {
      throw new Error(`claude-auth start failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { flowId: string; pageUrl: string };
    const result: IdentityLinkPageStart = { flow: "page", pageUrl: body.pageUrl, expiresInSeconds: 10 * 60 };
    return result;
  }

  /** Never actually invoked: `checkPendingIdentityLink` only calls `poll` for a `"device"`-flow pending link, and this provider's `start` never returns that. Throws if somehow reached, rather than silently no-op-ing. */
  async poll(): Promise<IdentityLinkPollStatus> {
    throw new Error("ClaudeAuthGatewayClient.poll is not supported -- the claude provider has no device-flow poll step");
  }

  async getToken(_provider: string, subject: string): Promise<IdentityLinkToken | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/token?subject=${encodeURIComponent(subject)}`, {
      headers: { authorization: `Bearer ${this.options.token}` },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`claude-auth token lookup failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { token: string };
    return { token: body.token };
  }

  async waitForCompletion(_provider: string, subject: string, timeoutMs: number): Promise<IdentityLinkToken | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/wait`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify({ subject, timeoutMs }),
    });
    if (!res.ok) {
      throw new Error(`claude-auth wait failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { status: "complete" | "timeout"; token?: string };
    return body.status === "complete" && body.token ? { token: body.token } : undefined;
  }

  async invalidate(_provider: string, subject: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/invalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify({ subject }),
    });
    if (!res.ok) {
      throw new Error(`claude-auth invalidate failed: ${res.status} ${await res.text()}`);
    }
  }
}
