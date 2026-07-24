import type { IdentityLinkPageStart, IdentityLinkPollStatus, IdentityLinkPort, IdentityLinkStartResult, IdentityLinkToken } from "./gateway-client.js";

/**
 * Thin client for apps/integration-gateway's internal claude-auth API
 * (src/claude-auth/api.ts) -- the `claude-remote`-provider counterpart of
 * `ClaudeAuthGatewayClient`. Same routes, same PTY-driven page flow, but
 * every request carries `mode: "login"` instead of the default
 * `"setup-token"`: the gateway runs a full `claude login` (not
 * `claude setup-token`) and hands back a `credentialsJson` blob (a whole
 * `~/.claude/.credentials.json`, used by claude-code-swe-agent's
 * remote-control invocation) rather than a single bearer token.
 *
 * `IdentityLinkPort.getToken`/`waitForCompletion` are typed to return an
 * `IdentityLinkToken` whose field is literally named `token` -- that name is
 * the PORT's contract, not a claim about content. This client populates that
 * field with the `credentialsJson` string verbatim; callers that resolve
 * this gateway (graph.ts's `identityGatewayFor` for the `"claude-remote"`
 * provider) inject it as `CLAUDE_LOGIN_CREDENTIALS_JSON`, not
 * `CLAUDE_CODE_OAUTH_TOKEN`.
 */
export interface ClaudeRemoteGatewayClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class ClaudeRemoteGatewayClient implements IdentityLinkPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClaudeRemoteGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `flow` is ignored -- this provider only ever has one flow shape (the PTY-driven page). Kept in the signature to satisfy `IdentityLinkPort`. */
  async start(_provider: string, subject: string): Promise<IdentityLinkStartResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify({ subject, mode: "login" }),
    });
    if (!res.ok) {
      throw new Error(`claude-auth start (login) failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { flowId: string; pageUrl: string };
    const result: IdentityLinkPageStart = { flow: "page", pageUrl: body.pageUrl, expiresInSeconds: 10 * 60 };
    return result;
  }

  /** Never actually invoked: `checkPendingIdentityLink` only calls `poll` for a `"device"`-flow pending link, and this provider's `start` never returns that. Throws if somehow reached, rather than silently no-op-ing. */
  async poll(): Promise<IdentityLinkPollStatus> {
    throw new Error("ClaudeRemoteGatewayClient.poll is not supported -- the claude-remote provider has no device-flow poll step");
  }

  async getToken(_provider: string, subject: string): Promise<IdentityLinkToken | undefined> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/claude-auth/api/token?subject=${encodeURIComponent(subject)}&mode=login`,
      { headers: { authorization: `Bearer ${this.options.token}` } },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`claude-auth token lookup (login) failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { credentialsJson: string };
    return { token: body.credentialsJson };
  }

  async waitForCompletion(_provider: string, subject: string, timeoutMs: number): Promise<IdentityLinkToken | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/wait`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify({ subject, mode: "login", timeoutMs }),
    });
    if (!res.ok) {
      throw new Error(`claude-auth wait (login) failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { status: "complete" | "timeout"; credentialsJson?: string };
    return body.status === "complete" && body.credentialsJson ? { token: body.credentialsJson } : undefined;
  }

  async invalidate(_provider: string, subject: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/invalidate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify({ subject, mode: "login" }),
    });
    if (!res.ok) {
      throw new Error(`claude-auth invalidate (login) failed: ${res.status} ${await res.text()}`);
    }
  }
}
