import { describe, expect, it, vi } from "vitest";
import type { IdentityLinkPort, IdentityLinkStartResult, IdentityLinkToken } from "../identity-link/gateway-client.js";
import type { Identity } from "../rbac/types.js";
import { ACTOR_LOGIN_ENV, AuthorizationService } from "./authorization-service.js";

/**
 * Unit tests for the extracted authorization pre-flight (docs/adr/0030 §1).
 *
 * These are deliberately about the DECISION, not the launch: graph.test.ts
 * already covers the end-to-end "what did delegateToAgent hand the launcher"
 * behaviour, and duplicating that here would mean two places to update for one
 * change. What's tested here is what the extraction made directly reachable --
 * the verdict for each shape of provider set, including the ones that were
 * previously only observable through a launched AgentRun.
 */

const identity = (over: Partial<Identity> = {}): Identity =>
  ({ subject: "openwebui:alice", roles: ["writer"], ...over }) as Identity;

/** A gateway whose per-provider behaviour is declared up front. */
function gateway(
  behaviour: Record<
    string,
    {
      token?: IdentityLinkToken;
      /** `"throw-once"` fails the first attempt only -- the transient PTY failure `startWithRetry` exists for. */
      start?: IdentityLinkStartResult | "throw" | "throw-once";
      waitResolvesTo?: IdentityLinkToken | "throw";
      /** A record sitting under the caller's raw subject, adoptable by `rekey` (docs/adr/0031). */
      prePrincipalToken?: IdentityLinkToken;
      /** A LINK that exists but whose access token is unusable: `getLinkedLogin` sees it, `getToken` does not. */
      staleLinkLogin?: string;
    }
  >,
): IdentityLinkPort {
  /** Subjects a `rekey` has moved a pre-principal record onto, so `getToken` starts finding it there. */
  const adopted = new Map<string, IdentityLinkToken>();
  /** Per-provider `start` call count, so `"throw-once"` can fail only the first. */
  const startAttempts = new Map<string, number>();
  return {
    getToken: vi.fn(async (provider: string, subject: string) => adopted.get(`${provider}@${subject}`) ?? behaviour[provider]?.token),
    getLinkedLogin: vi.fn(async (provider: string) => behaviour[provider]?.staleLinkLogin ?? behaviour[provider]?.token?.githubLogin),
    rekey: vi.fn(async (provider: string, from: string, to: string) => {
      const record = behaviour[provider]?.prePrincipalToken;
      if (!record || from === to) return false;
      adopted.set(`${provider}@${to}`, record);
      return true;
    }),
    start: vi.fn(async (provider: string) => {
      const s = behaviour[provider]?.start;
      if (s === "throw") throw new Error(`start failed for ${provider}`);
      if (s === "throw-once") {
        const seen = (startAttempts.get(provider) ?? 0) + 1;
        startAttempts.set(provider, seen);
        if (seen === 1) throw new Error(`start failed for ${provider} (transient)`);
        return { flow: "authcode", authorizeUrl: `https://link/${provider}`, expiresInSeconds: 600 } as IdentityLinkStartResult;
      }
      return s ?? ({ flow: "authcode", authorizeUrl: `https://link/${provider}`, expiresInSeconds: 600 } as IdentityLinkStartResult);
    }),
    poll: vi.fn(async () => "pending" as const),
    waitForCompletion: vi.fn(async (provider: string) => {
      const w = behaviour[provider]?.waitResolvesTo;
      if (w === "throw") throw new Error("fetch failed");
      return w;
    }),
  };
}

describe("AuthorizationService.authorize", () => {
  it("clears a launch and injects each provider's credential under its own env var", async () => {
    const svc = new AuthorizationService({
      claudeAuthGateway: gateway({ claude: { token: { token: "sk-ant-oat01-x" } } }),
      claudeRemoteGateway: gateway({ "claude-remote": { token: { token: '{"creds":1}' } } }),
    });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude", "claude-remote"] },
      identity: identity(),
      request: "do the thing",
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    expect(verdict.secretEnv).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-x" },
      { name: "CLAUDE_LOGIN_CREDENTIALS_JSON", value: '{"creds":1}' },
    ]);
  });

  it("clears a launch with no secretEnv when the agent declares no providers", async () => {
    const svc = new AuthorizationService({});
    const verdict = await svc.authorize({ agent: { id: "plain" }, identity: identity(), request: "hi" });
    // `principal` rides on every authorized verdict (docs/adr/0031) -- the raw
    // subject standing in for itself here, since nothing established a mapping.
    expect(verdict).toEqual({ kind: "authorized", principal: "openwebui:alice" });
  });

  it("keys cross-entry-point providers by principal and github by raw subject (§6)", async () => {
    // The PR #144 regression in miniature: a claude credential linked from chat
    // must be found by a webhook turn, so it keys on the principal; a github
    // link is a property of the account that established it and keys on the
    // subject -- keying it by principal would be circular, since the principal
    // is resolved FROM it.
    const github = gateway({ github: { token: { token: "gho_x", githubLogin: "alice" } } });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    await svc.authorize({
      agent: { id: "swe", identityProviders: ["github", "claude"] },
      identity: identity({ subject: "openwebui:alice", principal: "github:alice" }),
      request: "r",
    });

    expect(github.getToken).toHaveBeenCalledWith("github", "openwebui:alice");
    expect(claude.getToken).toHaveBeenCalledWith("claude", "github:alice");
  });

  it("starts EVERY missing link on one turn and reports them together (§4)", async () => {
    // The batching property. Before ADR 0030 the first gap returned, so a
    // caller with two unlinked providers spent two round trips discovering them
    // one at a time.
    const claude = gateway({ claude: {} });
    const remote = gateway({ "claude-remote": {} });
    const svc = new AuthorizationService({ claudeAuthGateway: claude, claudeRemoteGateway: remote });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude", "claude-remote"] },
      identity: identity(),
      request: "r",
    });

    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    expect(claude.start).toHaveBeenCalled();
    expect(remote.start).toHaveBeenCalled();
    expect(verdict.message).toContain("2 accounts");
  });

  it("reports a failed start ALONGSIDE the links that succeeded, not instead of them", async () => {
    // The exact coupling ADR 0030 removes: a GitHub OAuth outage used to end the
    // turn before claude was ever assessed, so it blocked Claude authorization
    // entirely.
    const github = gateway({ github: { start: "throw" } });
    const claude = gateway({ claude: {} });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["github", "claude"] },
      identity: identity(),
      request: "r",
    });

    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    // The Claude link is still offered...
    expect(verdict.message).toContain("link your Claude account");
    // ...and the GitHub failure is reported too, as an "also".
    expect(verdict.message).toContain("I also couldn't start the GitHub linking step");
    // The resume anchor is the started link, not the failed one.
    expect(verdict.pending?.provider).toBe("claude");
  });

  it("stands the failure message on its own when EVERY provider failed to start", async () => {
    const svc = new AuthorizationService({ identityLinkGateway: gateway({ github: { start: "throw" } }) });
    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["github"] },
      identity: identity(),
      request: "r",
    });

    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    expect(verdict.message).toMatch(/^I couldn't start the one-time GitHub account-linking step/);
    // Nothing started, so there is no anchor to resume against -- re-triggering
    // re-enters the gate and retries start().
    expect(verdict.pending).toBeUndefined();
  });

  it("resumes the same turn when a streaming caller completes the link during the wait", async () => {
    const claude = gateway({ claude: { waitResolvesTo: { token: "sk-ant-oat01-late" } } });
    const progress = vi.fn();
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity(),
      request: "r",
      progressListener: progress,
    });

    // The link was surfaced live, then the wait landed the token -- so the turn
    // proceeds instead of parking.
    expect(progress).toHaveBeenCalledWith("identity-link", expect.stringContaining("link your Claude account"));
    expect(verdict.kind).toBe("authorized");
  });

  it("parks pending rather than failing when the long-held wait throws", async () => {
    // A rolled gateway pod or a dropped idle connection surfaces as "fetch
    // failed". That does not mean the LINK failed -- the user can still finish
    // it in the browser -- so it must degrade to pending, not to an error.
    const claude = gateway({ claude: { waitResolvesTo: "throw" } });
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity(),
      request: "r",
      progressListener: vi.fn(),
    });

    expect(verdict.kind).toBe("link-required");
  });

  it("does not repeat a link in the final message when it was already surfaced live", async () => {
    // The "doubled up" prompt: the streamed message already carries the link.
    const svc = new AuthorizationService({ claudeAuthGateway: gateway({ claude: {} }) });
    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity(),
      request: "r",
      progressListener: vi.fn(),
    });

    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    expect(verdict.message).not.toContain("https://link/claude");
    expect(verdict.message).toContain("haven't received your Claude account link yet");
  });

  it("signals that a link is needed before the (possibly slow) start runs", async () => {
    const order: string[] = [];
    const svc = new AuthorizationService({
      claudeAuthGateway: {
        ...gateway({ claude: {} }),
        start: vi.fn(async () => {
          order.push("start");
          return { flow: "page", pageUrl: "https://p", expiresInSeconds: 600 } as IdentityLinkStartResult;
        }),
      },
    });

    await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity(),
      request: "r",
      reportIdentityLinkPending: () => order.push("reported"),
    });

    expect(order).toEqual(["reported", "start"]);
  });

  it("captures the subject start() was called with onto the resume anchor", async () => {
    // Recomputing the subject downstream instead of carrying it is the PR #144
    // re-auth loop.
    const svc = new AuthorizationService({ claudeAuthGateway: gateway({ claude: {} }) });
    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ subject: "openwebui:alice", principal: "github:alice" }),
      request: "the original goal",
    });

    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    expect(verdict.pending?.subject).toBe("github:alice");
    // And the goal, so the eventual resume re-delegates THIS request rather than
    // whatever text the turn that notices completion happens to carry.
    expect(verdict.pending?.request).toBe("the original goal");
  });

  it("carries a device flow's code onto the anchor so the resume can poll it", async () => {
    const svc = new AuthorizationService({
      identityLinkGateway: gateway({
        github: {
          start: {
            flow: "device",
            verificationUri: "https://github.com/login/device",
            userCode: "ABCD-1234",
            deviceCode: "dev-code",
            expiresInSeconds: 900,
            pollIntervalSeconds: 5,
          },
        },
      }),
    });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["github"] },
      identity: identity(),
      request: "r",
      identityLinkFlow: "device",
    });

    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    expect(verdict.pending?.deviceCode).toBe("dev-code");
    expect(verdict.message).toContain("ABCD-1234");
  });

  it("rejects a declared provider with no configured gateway as misconfigured, not unlinked", async () => {
    // No user action fixes this, so it must not render as a link prompt.
    const svc = new AuthorizationService({});
    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity(),
      request: "r",
    });

    expect(verdict.kind).toBe("misconfigured");
    if (verdict.kind !== "misconfigured") return;
    expect(verdict.error).toContain("no identity-link gateway is configured");
  });

  it("rejects an unknown provider that has no env var mapping", async () => {
    const svc = new AuthorizationService({ identityLinkGateway: gateway({ gitlab: { token: { token: "t" } } }) });
    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["gitlab"] },
      identity: identity(),
      request: "r",
    });

    expect(verdict.kind).toBe("misconfigured");
    if (verdict.kind !== "misconfigured") return;
    expect(verdict.error).toContain('unsupported identity provider "gitlab"');
  });
});

describe("AuthorizationService.authorize -- sealed actor context (§5)", () => {
  it("takes the actor login off the resolved github link, with no extra API call", async () => {
    const github = gateway({ github: { token: { token: "gho_x", githubLogin: "Alice" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["github"] },
      identity: identity(),
      request: "r",
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    expect(verdict.actorLogin).toBe("Alice");
    expect(verdict.secretEnv).toContainEqual({ name: ACTOR_LOGIN_ENV, value: "Alice" });
  });

  it("still resolves an actor login for an agent that declares no github provider", async () => {
    // claude-code-swe-agent's real shape after ADR 0030 decoupled `github` from
    // credential provisioning: no github provider declared, but the agent still
    // must be told who the caller is so it never calls /user itself.
    const svc = new AuthorizationService({
      claudeAuthGateway: gateway({ claude: { token: { token: "sk-ant-oat01-x" } } }),
      identityLinkGateway: gateway({ github: { token: { token: "gho_x", githubLogin: "bob" } } }),
    });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ subject: "github:bob" }),
      request: "r",
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    expect(verdict.secretEnv).toContainEqual({ name: ACTOR_LOGIN_ENV, value: "bob" });
  });
});

describe("AuthorizationService.authorize -- claude-remote write-back grant", () => {
  it("mints the grant against the SAME subject the credential was read from", async () => {
    // A grant minted against the raw subject would write refreshed credentials
    // to a record nothing ever reads, and the read side would keep serving the
    // pre-refresh copy until it died.
    const createWritebackGrant = vi.fn(async () => ({ url: "https://wb", token: "wb-token" }));
    const svc = new AuthorizationService({
      claudeRemoteGateway: gateway({ "claude-remote": { token: { token: "{}" } } }),
      claudeRemoteWriteback: { createWritebackGrant },
      agentRunTimeoutSeconds: 600,
    });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude-remote"] },
      identity: identity({ subject: "openwebui:alice", principal: "github:alice" }),
      request: "r",
    });

    expect(createWritebackGrant).toHaveBeenCalledWith("github:alice", 600 + 15 * 60);
    if (verdict.kind !== "authorized") return;
    expect(verdict.secretEnv).toContainEqual({ name: "CLAUDE_CREDENTIALS_WRITEBACK_URL", value: "https://wb" });
    expect(verdict.secretEnv).toContainEqual({ name: "CLAUDE_CREDENTIALS_WRITEBACK_TOKEN", value: "wb-token" });
  });

  it("launches without write-back rather than failing when no grant is available", async () => {
    const svc = new AuthorizationService({
      claudeRemoteGateway: gateway({ "claude-remote": { token: { token: "{}" } } }),
      claudeRemoteWriteback: { createWritebackGrant: vi.fn(async () => undefined) },
    });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude-remote"] },
      identity: identity(),
      request: "r",
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    expect(verdict.secretEnv?.map((e) => e.name)).toEqual(["CLAUDE_LOGIN_CREDENTIALS_JSON"]);
  });
});

describe("AuthorizationService.resolveLinkedCredentials", () => {
  it("resolves what is already linked without ever starting a flow", async () => {
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    const res = await svc.resolveLinkedCredentials({ identity: identity(), identityProviders: ["claude"] });

    expect(res).toEqual({ kind: "resolved", secretEnv: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-x" }] });
    // The v1 scope cut, asserted rather than described: a paused TOOL call has
    // no session slot to resume a started link against.
    expect(claude.start).not.toHaveBeenCalled();
  });

  it("reports the unlinked provider instead of composing a message", async () => {
    // The caller's error text names the TOOL, which the service has no business
    // knowing.
    const svc = new AuthorizationService({ claudeAuthGateway: gateway({ claude: {} }) });
    const res = await svc.resolveLinkedCredentials({ identity: identity(), identityProviders: ["claude"] });
    expect(res).toEqual({ kind: "not-linked", provider: "claude" });
  });

  it("uses the same principal-vs-subject keying as authorize()", async () => {
    const claude = gateway({ claude: { token: { token: "t" } } });
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    await svc.resolveLinkedCredentials({
      identity: identity({ subject: "openwebui:alice", principal: "github:alice" }),
      identityProviders: ["claude"],
    });

    expect(claude.getToken).toHaveBeenCalledWith("claude", "github:alice");
  });

  it("distinguishes a missing gateway from an unlinked account", async () => {
    const svc = new AuthorizationService({});
    expect(await svc.resolveLinkedCredentials({ identity: identity(), identityProviders: ["claude"] })).toEqual({
      kind: "gateway-missing",
      provider: "claude",
    });
  });

  it("resolves to nothing for a tool that declares no providers", async () => {
    const svc = new AuthorizationService({});
    expect(await svc.resolveLinkedCredentials({ identity: identity() })).toEqual({ kind: "resolved" });
  });
});

/**
 * The principal pre-flight (docs/adr/0031).
 *
 * These are the tests for the defect observed in production: chat kept writing
 * Claude credentials under `openwebui:<id>` while GitHub triage read
 * `github:<login>`, because only the webhook path could name a login. Sharing
 * is the property under test, so each case asserts on the SUBJECT a credential
 * was keyed by rather than on the message the user saw.
 */
describe("AuthorizationService.authorize principal pre-flight", () => {
  it("establishes a principal before keying any cross-entry-point credential", async () => {
    // A chat caller with no GitHub mapping yet. The claude gateway must not be
    // touched: starting its flow now would file the credential the user is
    // about to create under the raw subject -- the split this closes.
    const github = gateway({ github: {} });
    const claude = gateway({ claude: {} });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ perUser: true }),
      request: "fix the bug",
      progressListener: vi.fn(),
    });

    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    expect(github.start).toHaveBeenCalledWith("github", "openwebui:alice", "authcode");
    expect(claude.start).not.toHaveBeenCalled();
    // The resume anchor is the GitHub link, recorded against the subject it was
    // actually started with (the PR #144 store-vs-wait rule).
    expect(verdict.pending).toMatchObject({ provider: "github", subject: "openwebui:alice", agentId: "swe" });
    // The original goal rides along, so the resume re-delegates THIS request.
    expect(verdict.pending?.request).toBe("fix the bug");
  });

  it("keys the credential canonically in the SAME turn once the link lands, without injecting GITHUB_TOKEN", async () => {
    // The whole point: after linking, this chat turn reads the same
    // `claude@github:alice` record a triage turn reads -- and the link that
    // produced the mapping stays a mapping, never a credential for the run.
    const github = gateway({ github: { waitResolvesTo: { token: "gho_x", githubLogin: "Alice" } } });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ perUser: true }),
      request: "r",
      progressListener: vi.fn(),
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    // Lower-cased: a webhook echoes "Alice", the OAuth API normalizes it, and
    // two casings would key two records.
    expect(claude.getToken).toHaveBeenCalledWith("claude", "github:alice");
    expect(verdict.principal).toBe("github:alice");
    expect(verdict.secretEnv?.map((e) => e.name)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", ACTOR_LOGIN_ENV]);
    expect(verdict.actorLogin).toBe("Alice");
  });

  it("never starts a principal link for a caller with no live channel", async () => {
    // Security, not ergonomics: a webhook relay authenticates as its own
    // service account, so its subject is shared by every sender. A link filed
    // under it would hand that one person's credentials to every later
    // senderLogin-less turn. Such a turn degrades to the raw subject instead.
    const github = gateway({ github: {} });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ subject: "client-integration-gateway" }),
      request: "r",
    });

    expect(verdict.kind).toBe("authorized");
    expect(github.start).not.toHaveBeenCalled();
    expect(claude.getToken).toHaveBeenCalledWith("claude", "client-integration-gateway");
  });

  it("does nothing when the caller already has a canonical principal", async () => {
    // The webhook path with a verified senderLogin, and every chat turn after
    // the first: resolveIdentity already resolved it, so there is nothing to
    // establish and no extra round trip to pay for.
    const github = gateway({ github: {} });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ principal: "github:alice", perUser: true }),
      request: "r",
      progressListener: vi.fn(),
    });

    // No link flow, and no `github` TOKEN read at all: the only lookup is the
    // identity one (§5's actor login), which asks who the caller is rather than
    // whether their credential still works (docs/adr/0031).
    expect(github.start).not.toHaveBeenCalled();
    expect(github.getToken).not.toHaveBeenCalled();
    expect(github.getLinkedLogin).toHaveBeenCalledTimes(1);
  });

  it("degrades to the raw subject when the principal link cannot be started", async () => {
    // Sharing is an improvement, not a precondition. A GitHub OAuth hiccup must
    // not deny a run whose own credentials are already linked.
    const github = gateway({ github: { start: "throw" } });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ perUser: true }),
      request: "r",
      progressListener: vi.fn(),
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    expect(verdict.principal).toBe("openwebui:alice");
    expect(claude.getToken).toHaveBeenCalledWith("claude", "openwebui:alice");
    // Not reported to the user, and NOT in `failedToStart`: nothing the caller
    // did is wrong and nothing they can do fixes it.
    expect(verdict.kind).toBe("authorized");
  });

  it("keeps CRD provider ORDER irrelevant, including when github is declared too", async () => {
    // `[claude, github]` used to key the claude credential before any login was
    // known. The principal step runs first regardless, and the declared github
    // provider still gets its token injected -- mapping and credential are
    // separate concerns, not alternatives.
    const github = gateway({ github: { token: { token: "gho_x", githubLogin: "alice" } } });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude", "github"] },
      identity: identity({ perUser: true }),
      request: "r",
      progressListener: vi.fn(),
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    expect(claude.getToken).toHaveBeenCalledWith("claude", "github:alice");
    expect(verdict.secretEnv?.map((e) => e.name)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      ACTOR_LOGIN_ENV,
    ]);
  });
});

/**
 * Adopting a pre-principal credential (docs/adr/0031).
 *
 * Both flows now read the same key, but records written before principals
 * existed sit under the entry point's own subject. Charging a human a fresh
 * login to reproduce a credential the gateway is still holding is not a fix, so
 * the pre-flight moves it.
 */
describe("AuthorizationService.authorize pre-principal adoption", () => {
  it("adopts the caller's existing credential onto their principal instead of prompting", async () => {
    const claude = gateway({ claude: { prePrincipalToken: { token: "sk-ant-oat01-authorized-in-chat" } } });
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ principal: "github:alice", perUser: true }),
      request: "r",
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    expect(claude.rekey).toHaveBeenCalledWith("claude", "openwebui:alice", "github:alice");
    expect(verdict.secretEnv).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-authorized-in-chat" }]);
  });

  it("never adopts from a subject that is not per-user", async () => {
    // The webhook relay's subject is its own service account, shared by every
    // sender: moving a credential off it would hand whoever authorized first to
    // whoever triggered next. This turn must park instead.
    const claude = gateway({ claude: { prePrincipalToken: { token: "sk-ant-oat01-someone-elses" } } });
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ subject: "client-integration-gateway", principal: "github:sender" }),
      request: "r",
      senderLogin: "sender",
    });

    expect(claude.rekey).not.toHaveBeenCalled();
    expect(verdict.kind).toBe("link-required");
  });

  it("does not attempt a move when the principal IS the subject", async () => {
    // Nothing to converge, and a self-move is the degenerate case that would
    // delete the record it just wrote if the store took it literally.
    const claude = gateway({ claude: { prePrincipalToken: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ perUser: true }),
      request: "r",
    });

    expect(claude.rekey).not.toHaveBeenCalled();
  });

  it("falls back to the ordinary link prompt when there is nothing to adopt", async () => {
    const claude = gateway({ claude: {} });
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ principal: "github:alice", perUser: true }),
      request: "r",
    });

    expect(claude.rekey).toHaveBeenCalled();
    expect(verdict.kind).toBe("link-required");
    if (verdict.kind !== "link-required") return;
    // Started against the principal, as always -- adoption changes nothing
    // about which subject a NEW credential is filed under.
    expect(verdict.pending?.subject).toBe("github:alice");
  });

  it("prompts rather than failing the turn when a gateway has no rekey at all", async () => {
    // `IdentityLinkPort.rekey` is optional (the github client doesn't implement
    // it), so absence must read as "nothing to adopt", not as a crash.
    const claude = gateway({ claude: {} });
    delete (claude as { rekey?: unknown }).rekey;
    const svc = new AuthorizationService({ claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ principal: "github:alice", perUser: true }),
      request: "r",
    });

    expect(verdict.kind).toBe("link-required");
  });
});

/**
 * Never prompt for a link that already exists (docs/adr/0031).
 *
 * The production symptom this pins: a caller whose `github` link had expired
 * overnight was asked to link on EVERY chat turn -- and the turn then completed
 * anyway, 0.3s later, because `waitForCompletion` reads the stored record raw
 * while `getToken` refuses a record whose token can no longer be refreshed. The
 * pre-flight was asking a credential question ("can I use this token?") to
 * decide an identity one ("who is this?").
 */
describe("AuthorizationService.authorize principal from an existing link", () => {
  it("resolves the principal from a link whose token is no longer usable, without prompting", async () => {
    // The exact production state: a stored link for "imaustink" that `getToken`
    // reports as nothing (expired, refresh failed) but whose login is right there.
    const github = gateway({ github: { staleLinkLogin: "imaustink" } });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ perUser: true }),
      request: "r",
      progressListener: vi.fn(),
    });

    expect(verdict.kind).toBe("authorized");
    if (verdict.kind !== "authorized") return;
    // No link flow started, and no prompt: the mapping was already established.
    expect(github.start).not.toHaveBeenCalled();
    expect(verdict.principal).toBe("github:imaustink");
    expect(claude.getToken).toHaveBeenCalledWith("claude", "github:imaustink");
    expect(verdict.actorLogin).toBe("imaustink");
  });

  it("still offers the link when nothing is linked at all", async () => {
    // The distinction that matters: "your token expired" is not "you have no
    // GitHub identity". Only the second warrants a prompt.
    const github = gateway({ github: {} });
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ perUser: true }),
      request: "r",
      progressListener: vi.fn(),
    });

    expect(github.start).toHaveBeenCalled();
    expect(verdict.kind).toBe("link-required");
  });

  it("degrades rather than failing when the identity lookup throws", async () => {
    const github = gateway({ github: { staleLinkLogin: "imaustink" } });
    (github.getLinkedLogin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gateway down"));
    const claude = gateway({ claude: { token: { token: "sk-ant-oat01-x" } } });
    const svc = new AuthorizationService({ identityLinkGateway: github, claudeAuthGateway: claude });

    const verdict = await svc.authorize({
      agent: { id: "swe", identityProviders: ["claude"] },
      identity: identity({ perUser: true }),
      request: "r",
    });

    // Falls through on the raw subject: no sharing this turn, no link prompt
    // either. A blip must not ask someone to redo a one-time step they already
    // did -- which is the whole failure mode this ADR is cleaning up after.
    expect(verdict.kind).toBe("authorized");
    expect(github.start).not.toHaveBeenCalled();
  });
});

/**
 * The "I authorized, and it asked me to authorize again" regression.
 *
 * What happened in production: `claude-code-swe-agent` declares BOTH `claude`
 * and `claude-remote`. The gateway pod had been pushed to its memory ceiling
 * (@kubernetes/client-node's ~88 MiB, added when credentials moved into Secrets,
 * against a 256 MiB limit), so the second `claude` PTY spawned into a cgroup
 * with no headroom and printed nothing within its 30s authorize-URL timeout.
 *
 *   12:42 "please link your Claude account ... I also couldn't start the
 *          Claude linking step just now"
 *   12:45 "please link your Claude account"        <- other provider, same words
 *
 * ADR 0030 §4 says every missing link is started on ONE turn and reported
 * together. A failed start silently broke that: the user completed the one link
 * they were offered and the next turn offered them the other, which reads as the
 * system having lost the authorization it was just given.
 *
 * Three defences, one per test below. The resource limit is fixed at the source
 * (charts/.../integration-gateway/values.yaml) and cannot be asserted here.
 */
describe("AuthorizationService.authorize -- one turn offers every outstanding link", () => {
  const bothClaudeProviders = { id: "claude-code-swe-agent", identityProviders: ["claude", "claude-remote"] };

  it("retries a transient start failure so the link is still offered on THIS turn", async () => {
    const svc = new AuthorizationService({
      claudeAuthGateway: gateway({ claude: {} }),
      claudeRemoteGateway: gateway({ "claude-remote": { start: "throw-once" } }),
    });

    const outcome = await svc.authorize({
      agent: bothClaudeProviders,
      identity: identity(),
      request: "triage this",
    });

    expect(outcome.kind).toBe("link-required");
    if (outcome.kind !== "link-required") throw new Error("unreachable");
    // Both offered NOW. Before the retry, claude-remote landed in `failedToStart`
    // and its prompt arrived a turn later as a second authorization request.
    expect(outcome.message).toContain("link your Claude account");
    expect(outcome.message).toContain("link your Claude Remote Control account");
    expect(outcome.message).not.toContain("couldn't start");
  });

  it("names the two credentials distinctly, so a second prompt is not mistaken for a repeat", async () => {
    const svc = new AuthorizationService({
      claudeAuthGateway: gateway({ claude: {} }),
      claudeRemoteGateway: gateway({ "claude-remote": {} }),
    });

    const outcome = await svc.authorize({
      agent: bothClaudeProviders,
      identity: identity(),
      request: "triage this",
    });

    if (outcome.kind !== "link-required") throw new Error(`expected link-required, got ${outcome.kind}`);
    // While both read "Claude", this message asked the user to "link your Claude
    // account, and link your Claude account" -- the same words twice.
    expect(outcome.message).toContain("2 accounts");
    expect(outcome.message).toContain("Claude Remote Control");
    expect(outcome.message.match(/link your Claude account/g) ?? []).toHaveLength(1);
  });

  it("still reports a genuinely unstartable provider alongside the others", async () => {
    // The retry must not turn a real, persistent failure into a hang or a
    // swallowed provider: it is reported, the turn survives, and the other
    // provider's link is still offered (ADR 0030 §4's decoupling).
    const svc = new AuthorizationService({
      claudeAuthGateway: gateway({ claude: {} }),
      claudeRemoteGateway: gateway({ "claude-remote": { start: "throw" } }),
    });

    const outcome = await svc.authorize({
      agent: bothClaudeProviders,
      identity: identity(),
      request: "triage this",
    });

    if (outcome.kind !== "link-required") throw new Error(`expected link-required, got ${outcome.kind}`);
    expect(outcome.message).toContain("link your Claude account");
    expect(outcome.message).toContain("Claude Remote Control");
    expect(outcome.message).toContain("couldn't start");
  });

  it("makes exactly one extra attempt, not an unbounded loop inside the turn", async () => {
    // A human (or the relay's poll budget) is waiting on this turn, and a failed
    // `claude` start has already spent its own 30s timeout.
    const claudeRemote = gateway({ "claude-remote": { start: "throw" } });
    const svc = new AuthorizationService({
      claudeAuthGateway: gateway({ claude: { token: { token: "sk-ant-oat01-x" } as IdentityLinkToken } }),
      claudeRemoteGateway: claudeRemote,
    });

    await svc.authorize({ agent: bothClaudeProviders, identity: identity(), request: "triage this" });

    expect(claudeRemote.start).toHaveBeenCalledTimes(2);
  });
});
