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

  /**
   * Asks the gateway for a narrow, expiring grant that lets ONE AgentRun
   * persist the `~/.claude/.credentials.json` its Claude Code CLI refreshed
   * in-pod (see the gateway's `POST /claude-auth/api/refresh`). Injected into
   * the run alongside the credentials themselves; without it a refreshed --
   * and therefore rotated -- credential dies with the pod and the stored copy
   * goes stale, which is what made a freshly-linked account start failing with
   * "Login expired" hours later.
   *
   * Returns `undefined` rather than throwing when the gateway can't mint one
   * (older gateway without the route, credential store unreachable): write-back
   * is an availability improvement, not a precondition for running, so a failure
   * here must never block the launch it was being prepared for.
   *
   * `secretName` is the object backing the grant, which the launcher makes the
   * AgentRun own so Kubernetes reclaims it with the run (docs/adr/0034).
   * Optional: a gateway older than that ADR does not send it, in which case the
   * grant still works and simply lingers as an object until swept, having
   * already stopped authorizing anything at its expiry.
   */
  async createWritebackGrant(
    subject: string,
    ttlSeconds: number,
  ): Promise<{ url: string; token: string; secretName?: string } | undefined> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/writeback-token`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify({ subject, ttlSeconds }),
      });
      if (!res.ok) {
        console.error(`claude-auth writeback-token failed (continuing without write-back): ${res.status}`);
        return undefined;
      }
      const body = (await res.json()) as { token?: string; url?: string; secretName?: string };
      if (!body.token || !body.url) return undefined;
      return { url: body.url, token: body.token, ...(body.secretName ? { secretName: body.secretName } : {}) };
    } catch (err) {
      console.error(
        "claude-auth writeback-token threw (continuing without write-back):",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
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

  /**
   * Best-effort by design: a rekey that fails leaves the credential where it
   * was, which costs the caller a re-link at worst. Throwing instead would turn
   * a missed OPTIMIZATION into a failed turn.
   */
  async rekey(_provider: string, fromSubject: string, toSubject: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/claude-auth/api/rekey`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify({ from: fromSubject, to: toSubject, mode: "login" }),
      });
      if (!res.ok) {
        console.error(`claude-auth rekey (login) failed (leaving the credential where it is): ${res.status}`);
        return false;
      }
      const body = (await res.json()) as { status?: string };
      return body.status === "moved";
    } catch (err) {
      console.error(
        "claude-auth rekey (login) threw (leaving the credential where it is):",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }
}
