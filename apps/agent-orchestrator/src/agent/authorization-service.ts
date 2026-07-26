import type { IdentityLinkPort, IdentityLinkStartResult } from "../identity-link/gateway-client.js";
import { canonicalSubjectForLogin, isCanonicalPrincipal, resolveActorLogin } from "../identity-link/credential-subject.js";
import type { Identity } from "../rbac/types.js";

/**
 * The authorization pre-flight: given the caller and the Agent they are about
 * to invoke, decide whether the launch may proceed and, if so, exactly which
 * credentials it carries (docs/adr/0030 §1).
 *
 * ## Why this is a class and not a tool
 *
 * ADR 0030 §1's property is that authorization has ONE owner and that owner is
 * graph control flow -- never something the planner can select, skip, or
 * re-order. That property already held before this file existed: the logic ran
 * inline in `delegateToAgent`, on the only path to a launch. What it lacked was
 * a name and a boundary, so "where is authorization decided" was answered by
 * reading 300 lines of a graph node, and the property was true by inspection
 * rather than by construction.
 *
 * Extracting it changes no behaviour. It makes the property legible: the
 * decision has a single entry point ({@link authorize}), a total return type
 * ({@link AuthorizationOutcome}) whose cases the caller must handle, and no
 * dependency on graph state beyond what {@link AuthorizationRequest} names.
 * Nothing here is reachable from a model-selected code path -- there is no tool
 * schema, no prompt, and the class is constructed once from deps in index.ts.
 *
 * ## What it deliberately does NOT do
 *
 * It does not launch, and it does not compose the user-facing turn beyond the
 * link prompts it owns. Keeping the launch in the graph node keeps this class's
 * contract to "decide", so a future caller can ask for an authorization verdict
 * without side effects.
 */

/** Env var carrying the caller's resolved GitHub login into a run (docs/adr/0030 §5). */
export const ACTOR_LOGIN_ENV = "AGENT_ACTOR_LOGIN";

/**
 * Providers whose credential is keyed by PRINCIPAL rather than by the
 * entry-point subject -- i.e. the ones a human re-authorizes by hand and
 * expects to only do once (docs/adr/0030 §6).
 */
export const CROSS_ENTRY_POINT_PROVIDERS: ReadonlySet<string> = new Set(["claude", "claude-remote"]);

/**
 * The provider whose link ESTABLISHES a principal (docs/adr/0031).
 *
 * GitHub, because it is the one identity both entry points can reach: a webhook
 * vouches for the sender, and a chat caller can prove control of the account.
 * Nothing else about the pre-flight is GitHub-specific -- when principals become
 * first-class (ADR 0030 §6's alias table), this is the constant that stops
 * meaning "GitHub" and starts meaning "whatever establishes the alias".
 */
export const PRINCIPAL_PROVIDER = "github";

/**
 * Maps an identity-linked provider (Agent.identityProviders, e.g. "github") to
 * the env var name its linked token is injected as (AgentLaunchOptions'
 * secretEnv, agentrun-launcher.ts).
 */
export const PROVIDER_ENV_VAR: Record<string, string> = {
  github: "GITHUB_TOKEN",
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  "claude-remote": "CLAUDE_LOGIN_CREDENTIALS_JSON",
};

/**
 * Env vars a `claude-remote` launch carries so the run can persist the
 * credentials its Claude Code CLI refreshes in-pod (the gateway's
 * `POST /claude-auth/api/refresh`, read by claude-code-swe-agent's
 * `config.ts`). Injected via the same `secretEnv` channel as the credential
 * itself -- the grant token is a bearer credential, short-lived and scoped to
 * one subject, but still not something to hand over as plaintext `env`.
 */
const CREDENTIALS_WRITEBACK_ENV = {
  url: "CLAUDE_CREDENTIALS_WRITEBACK_URL",
  token: "CLAUDE_CREDENTIALS_WRITEBACK_TOKEN",
} as const;

/**
 * Extra headroom on top of the run's own timeout for a write-back grant's
 * lifetime: the CLI can refresh at the very end of a long turn, and a grant
 * that expires mid-run silently drops exactly the refresh this mechanism
 * exists to capture.
 */
const WRITEBACK_GRANT_MARGIN_SECONDS = 15 * 60;

/** Human-facing label for a provider, used in link prompts/messages. */
export const PROVIDER_LABEL: Record<string, string> = { github: "GitHub", claude: "Claude", "claude-remote": "Claude" };

/** A `secretEnv` entry destined for the launched run. Values are credentials; never log one. */
export interface CredentialEnvEntry {
  name: string;
  value: string;
}

/** The resume anchor a parked link is recorded against. Shape mirrors AgentState's `pendingIdentityLink`. */
export interface PendingIdentityLink {
  agentId: string;
  provider: string;
  flow: string;
  deviceCode?: string;
  expiresAt: number;
  subject: string;
  request: string;
}

/**
 * Everything the pre-flight needs, named explicitly rather than handed the
 * whole graph state -- so it is obvious that authorization depends on the
 * caller's identity and the Agent's declarations, and on nothing the model
 * produced this turn beyond the request text it carries forward on a resume.
 */
export interface AuthorizationRequest {
  /** The Agent about to be launched: its id and the providers it declares. */
  agent: { id: string; identityProviders?: string[] };
  /** The resolved caller (subject, principal, roles). */
  identity: Identity;
  /** This turn's request text, captured onto a parked link so the resume re-delegates THIS goal. */
  request: string;
  /** Sender login from a forwarded assertion, used as an actor-login fallback (docs/adr/0030 §5/§6). */
  senderLogin?: string;
  /** Present on a streaming chat turn; absent on a fire-and-forget caller (e.g. the GitHub-issue relay). */
  progressListener?: (stage: string, message: string) => void;
  /** Notified as soon as a turn is known to need a link, before the (possibly slow) start(). */
  reportIdentityLinkPending?: (info: { provider: string; subject: string }) => void;
  /** `"device"` for a headless caller with no browser to redirect; defaults to `"authcode"`. */
  identityLinkFlow?: "device" | "authcode";
}

/**
 * The pre-flight's verdict. A discriminated union rather than a nullable
 * result: every case is a real outcome the caller must handle, and adding a
 * fourth would break compilation at the branch instead of falling through to
 * "launch anyway", which is the failure direction that matters here.
 */
export type AuthorizationOutcome =
  /**
   * Cleared to launch. `secretEnv` is the credentials + actor context the run
   * receives.
   *
   * `principal` is the one the credentials were actually keyed by, which the
   * pre-flight may have UPGRADED this turn by establishing a mapping
   * (docs/adr/0031). The caller must persist it onto the turn's identity:
   * anything that later re-derives the credential's key -- notably the
   * expired-credential invalidate path -- would otherwise clear a record that
   * was never written and leave the caller re-reading a dead credential
   * forever.
   */
  | { kind: "authorized"; secretEnv?: CredentialEnvEntry[]; actorLogin?: string; principal?: string }
  /**
   * Not cleared: one or more links are outstanding, or a link flow could not be
   * started. `message` is the complete user-facing text for the turn, including
   * every provider -- see the batch verdict in {@link AuthorizationService.authorize}.
   */
  | { kind: "link-required"; message: string; pending?: PendingIdentityLink }
  /**
   * Not cleared, and not the caller's fault: the deployment declares a provider
   * it has no gateway for, or an unknown provider entirely. Distinct from
   * `link-required` because no amount of user action fixes it.
   */
  | { kind: "misconfigured"; error: string };

export interface AuthorizationServiceDeps {
  /** GitHub-provider gateway (device/authcode flows). */
  identityLinkGateway?: IdentityLinkPort;
  /** `claude`-provider gateway (PTY `setup-token`, docs/adr/0027). */
  claudeAuthGateway?: IdentityLinkPort;
  /** `claude-remote`-provider gateway (full `~/.claude/.credentials.json` login). */
  claudeRemoteGateway?: IdentityLinkPort;
  /** Mints the per-run credential write-back grant a `claude-remote` launch carries. */
  claudeRemoteWriteback?: {
    createWritebackGrant(subject: string, ttlSeconds: number): Promise<{ url: string; token: string } | undefined>;
  };
  /** The launched run's timeout, used to size a write-back grant's lifetime. */
  agentRunTimeoutSeconds?: number;
}

/**
 * Renders the "link your account" clause for one started flow -- one line of
 * markdown, embedded into a larger sentence by every caller, which is why it
 * carries no leading capital and no trailing period.
 */
export function linkPromptText(started: IdentityLinkStartResult, label: string): string {
  if (started.flow === "device") {
    return `[link your ${label} account](${started.verificationUri}) and enter code \`${started.userCode}\``;
  }
  if (started.flow === "authcode") return `[link your ${label} account](${started.authorizeUrl})`;
  return `[link your ${label} account](${started.pageUrl})`;
}

export class AuthorizationService {
  constructor(private readonly deps: AuthorizationServiceDeps) {}

  /**
   * Resolves which gateway backs a given identity provider (docs/adr/0027) --
   * the one place that knows `"claude"` routes to `claudeAuthGateway` and
   * `"claude-remote"` to `claudeRemoteGateway`, instead of the
   * (GitHub-only-in-practice) `identityLinkGateway`, so the provider loop stays
   * provider-agnostic.
   */
  private gatewayFor(provider: string): IdentityLinkPort | undefined {
    if (provider === "claude") return this.deps.claudeAuthGateway;
    if (provider === "claude-remote") return this.deps.claudeRemoteGateway;
    return this.deps.identityLinkGateway;
  }

  /**
   * The single authorization decision point for an agent launch.
   *
   * Assesses EVERY declared provider before returning anything. Nothing
   * short-circuits on the first gap (docs/adr/0030 §4): all missing links are
   * started on this one turn and reported together, and a provider whose start
   * failed is reported ALONGSIDE the others rather than instead of them.
   * Previously the first gap ended the turn, which made provider order
   * load-bearing -- a GitHub OAuth outage blocked Claude authorization
   * entirely.
   */
  async authorize(req: AuthorizationRequest): Promise<AuthorizationOutcome> {
    const { agent, identity } = req;
    let secretEnv: CredentialEnvEntry[] | undefined;

    // Batch pre-flight accumulators (docs/adr/0030 §4).
    const pendingLinks: {
      provider: string;
      label: string;
      linkUrlText: string;
      surfacedLive: boolean;
      pending: PendingIdentityLink;
    }[] = [];
    const failedToStart: string[] = [];
    /**
     * The caller's GitHub login, read off their resolved `github` link.
     *
     * Deliberately taken from the link record rather than a `/user` call: the
     * login is already stored there, so the orchestrator needs neither an API
     * round trip nor the GitHub App credentials to know it. This is what lets
     * the agent stop calling `/user` itself (docs/adr/0030 §5) -- the call that
     * was returning 401 in production.
     */
    let actorLoginFromLoop: string | undefined;

    // ── Principal pre-flight (docs/adr/0031) ───────────────────────────────
    // A cross-entry-point credential can only be SHARED if this caller has a
    // principal to key it by. The webhook path always does (the verified
    // `senderLogin`); the chat path only does once a `github` link exists to
    // read a login off -- and links were only ever created as a side effect of
    // an Agent's `identityProviders`, which ADR 0030 §5 removed `github` from.
    // So chat kept writing credentials under its raw `openwebui:<id>` subject
    // while triage read `github:<login>`, and the two never converged.
    //
    // Fix: when a run needs a cross-entry-point credential and no principal is
    // established, establish one FIRST, with an ordinary `github` link that is
    // deliberately LINK-ONLY -- its token is never injected into the run. That
    // keeps the mapping separable from credential provisioning, which is the
    // conflation ADR 0030 §5 identified as the cause of the production 401:
    // declaring `github` to obtain a login also handed the agent a
    // `GITHUB_TOKEN` and activated its delegated-write path.
    //
    // Deliberately first in the plan so provider ORDER in the CRD stays
    // irrelevant (ADR 0030 §4) -- a `[claude, github]` Agent must not key its
    // claude credential before the principal is known.
    let principal = identity.principal ?? identity.subject;
    let principalLogin: string | undefined;
    const providerPlan: { name: string; principalOnly?: boolean }[] = (agent.identityProviders ?? []).map((name) => ({
      name,
    }));
    if (
      providerPlan.some((p) => CROSS_ENTRY_POINT_PROVIDERS.has(p.name)) &&
      !isCanonicalPrincipal(principal) &&
      this.deps.identityLinkGateway &&
      // PER-USER subjects only, and this guard is load-bearing security rather
      // than ergonomics. A webhook relay authenticates as the gateway's own
      // service account, so its subject is SHARED by every sender: filing a
      // login under it would make every later senderLogin-less webhook turn
      // inherit that one person's Claude credentials. A webhook turn with a
      // real human behind it already carries `senderLogin` and never needs this
      // path -- one without is exactly the case that must not take it.
      //
      // Asserted by the resolver that knows (`Identity.perUser`) rather than
      // inferred here from a proxy like "has a live channel": a shared subject
      // arriving on a streaming caller would pass that proxy, which is unsound
      // in the one direction that leaks. Absent the assertion this degrades to
      // the pre-principal behaviour (no sharing), never to the wrong principal.
      identity.perUser === true
    ) {
      providerPlan.unshift({ name: PRINCIPAL_PROVIDER, principalOnly: true });
    }

    for (const entry of providerPlan) {
      const provider = entry.name;
      const gateway = this.gatewayFor(provider);
      if (!gateway) {
        this.logVerdict("misconfigured", agent.id, { provider, reason: "no gateway configured" });
        return {
          kind: "misconfigured",
          error: `agent ${agent.id} requires identity providers (${agent.identityProviders!.join(", ")}) but no identity-link gateway is configured for "${provider}"`,
        };
      }

      // The principal for cross-entry-point credentials; the raw subject for
      // anything scoped to this entry point (docs/adr/0030 §6).
      //
      // `github` stays on the raw subject deliberately: a GitHub link is a
      // property of the specific account that established it, and it is the very
      // thing principal resolution reads, so keying it by principal would be
      // circular.
      const credentialSubject = CROSS_ENTRY_POINT_PROVIDERS.has(provider) ? principal : identity.subject;

      let existing = await gateway.getToken(provider, credentialSubject);

      // ── Adopt a pre-principal credential (docs/adr/0031) ─────────────────
      // Nothing at the principal, but this caller may well have authorized
      // already -- under their entry point's own subject, which is where these
      // records were keyed before principals existed. Both flows now READ the
      // principal; moving the record is what makes the credential the human
      // already created actually BE there, instead of charging them a fresh
      // login to reproduce something the gateway is still holding.
      //
      // Lazily, on the turn that needs it, rather than as a migration job: the
      // set of (subject, principal) pairs is only knowable from a caller's own
      // authenticated turn, and a batch job would have to invent that mapping.
      //
      // Gated on `perUser` for the same reason establishing a principal is: a
      // shared subject's credential belongs to whoever authorized first, and
      // moving it under a sender's principal would hand it to them outright.
      // The webhook path's subject IS shared, so it never adopts -- it reads
      // only what its own principal already has.
      if (
        !existing &&
        CROSS_ENTRY_POINT_PROVIDERS.has(provider) &&
        identity.perUser === true &&
        credentialSubject !== identity.subject &&
        (await gateway.rekey?.(provider, identity.subject, credentialSubject))
      ) {
        existing = await gateway.getToken(provider, credentialSubject);
        console.log(
          `[authorization] adopted this caller's pre-principal ${provider} credential onto their principal; no re-authorization needed`,
        );
      }

      if (!existing) {
        // Signal "this turn needs a link" NOW, before the (possibly slow)
        // start() below -- a fire-and-forget caller uses this to avoid
        // prematurely announcing that work has started while the link is still
        // being set up. Safe to fire before we even have the link URL.
        req.reportIdentityLinkPending?.({ provider, subject: credentialSubject });

        // Ordinary Open WebUI chat turns never set `identityLinkFlow`, so they
        // default to the browser-redirect authcode flow; a headless direct
        // `/invoke` caller (e.g. integration-gateway's own GitHub-issue relay)
        // can force the device flow instead, since it has no browser to
        // redirect. Ignored by the `claude` provider's gateway client (it only
        // has one flow shape).
        const flow = req.identityLinkFlow ?? "authcode";

        // Starting the link flow can itself fail before there is any URL to
        // show. For "github" this is a plain HTTP call and rarely throws; for
        // "claude" (docs/adr/0027) start() spawns a `claude setup-token` PTY and
        // scrapes the authorize URL within a timeout, so a missing/slow CLI, a
        // crashed PTY, or a URL that never prints all surface here as a throw.
        // That must NOT crash the turn into a raw "Something went wrong" -- on
        // the fire-and-forget GitHub-issue triage path that error is what gets
        // posted to the ticket.
        const started = await gateway.start(provider, credentialSubject, flow).catch((err: unknown) => {
          console.error(
            `[authorization] start threw for provider ${provider}; reporting it alongside the other providers instead of failing the turn: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        });
        if (!started) {
          // A principal link that won't start must DEGRADE, not block: sharing
          // is an improvement over per-entry-point keying, and refusing the
          // turn over it would make a GitHub OAuth hiccup deny a run whose own
          // credentials are already linked -- the coupling ADR 0030 §4 removed.
          if (entry.principalOnly) {
            console.error(
              `[authorization] could not start the principal-establishing ${PRINCIPAL_PROVIDER} link; continuing keyed by the raw subject, so this run's credentials will not be shared across entry points`,
            );
            continue;
          }
          failedToStart.push(PROVIDER_LABEL[provider] ?? provider);
          continue;
        }

        const label = PROVIDER_LABEL[provider] ?? provider;
        const linkUrlText = linkPromptText(started, label);

        // How the link reaches the caller depends on whether this turn has a
        // live channel (a streaming `progressListener`):
        //
        // - Streaming chat turn: surface the link LIVE now, then block up to the
        //   flow's expiry on `waitForCompletion` -- the gateway's Redis-backed
        //   wait by (provider, subject), which resolves the moment EITHER flow
        //   lands a token -- so the SAME turn resumes automatically once the user
        //   links, no follow-up message needed. `/invoke`'s async accept/poll
        //   contract (ADR 0006) tolerates the multi-minute run.
        //
        // - Fire-and-forget caller (no progressListener -- e.g.
        //   integration-gateway's GitHub-issue triage relay): there is NO live
        //   channel, so the link reaches the user ONLY in this turn's final
        //   result (posted as an issue comment). Blocking here would hide the
        //   link for the entire wait window -- nobody can complete a link they
        //   can't see yet, so the wait can only ever time out. So skip the wait
        //   and let checkPendingIdentityLink resume on the next trigger.
        if (req.progressListener) {
          req.progressListener(
            "identity-link",
            `To continue, please ${linkUrlText}. This is a one-time step — I'll continue automatically once you finish.`,
          );
          try {
            existing = await gateway.waitForCompletion?.(provider, credentialSubject, started.expiresInSeconds * 1000);
          } catch (err) {
            // The long-held wait is inherently fragile: the gateway pod can roll
            // (a deploy mid-flow), an intermediary can drop an idle connection,
            // or undici can abort a multi-minute request on its own headers
            // timeout -- all surface here as a thrown "fetch failed". None of
            // that means the LINK failed: the user can still complete it in
            // their browser. So swallow the throw and fall through to the same
            // pending-link state a plain timeout produces.
            console.error(
              `[authorization] waitForCompletion threw for provider ${provider}; treating as not-yet-linked and parking pending: ${err instanceof Error ? err.message : String(err)}`,
            );
            existing = undefined;
          }
        }

        if (!existing) {
          pendingLinks.push({
            provider,
            label,
            linkUrlText,
            // On a streaming chat turn the full link prompt was ALREADY surfaced
            // live; repeating the same markdown in the terminal result makes the
            // caller render the auth prompt twice (the "doubled up" message).
            surfacedLive: Boolean(req.progressListener),
            pending: {
              agentId: agent.id,
              provider,
              flow: started.flow,
              ...(started.flow === "device" ? { deviceCode: started.deviceCode } : {}),
              expiresAt: Date.now() + started.expiresInSeconds * 1000,
              // The subject `start` was actually called with -- recomputing it
              // downstream instead is the PR #144 re-auth loop.
              subject: credentialSubject,
              // Captured so the eventual resume re-delegates with THIS goal, not
              // whatever text the turn that finally notices completion carries.
              request: req.request,
            },
          });
          // Assess nothing further when it is the PRINCIPAL that is pending: the
          // remaining providers would have to be keyed by a subject this turn is
          // about to abandon, so starting their flows would file the credentials
          // the user is about to create under the raw subject -- creating
          // exactly the split this change exists to close. The resume turn
          // re-enters with a canonical principal and assesses them all then.
          if (entry.principalOnly) break;
          continue;
        }
      }

      // A link-only principal step: it contributes the mapping and nothing else.
      // No `secretEnv` entry, so no `GITHUB_TOKEN` reaches the run and the
      // agent's delegated-write path stays unreachable (docs/adr/0030 §5).
      if (entry.principalOnly) {
        if (existing.githubLogin) {
          principalLogin = existing.githubLogin;
          principal = canonicalSubjectForLogin(existing.githubLogin);
        } else {
          // A link with no login on it can't produce a mapping. Degrade to the
          // raw subject rather than failing a turn over a missing nicety.
          console.error(
            `[authorization] the ${PRINCIPAL_PROVIDER} link for this caller carries no login; continuing keyed by the raw subject, without cross-entry-point sharing`,
          );
        }
        continue;
      }

      // Capture the login off whichever way this credential arrived. On a
      // streaming turn it lands via waitForCompletion, so the standalone lookup
      // below would miss it -- but that lookup is still needed for Agents that
      // do NOT declare `github` at all (docs/adr/0030).
      if (provider === "github" && existing.githubLogin) actorLoginFromLoop = existing.githubLogin;

      const envVarName = PROVIDER_ENV_VAR[provider];
      if (!envVarName) {
        this.logVerdict("misconfigured", agent.id, { provider, reason: "no env var mapping" });
        return { kind: "misconfigured", error: `agent ${agent.id} declares unsupported identity provider "${provider}"` };
      }
      secretEnv = [...(secretEnv ?? []), { name: envVarName, value: existing.token }];

      // `claude-remote` only: its credential is a whole
      // `~/.claude/.credentials.json` that the run's own CLI refreshes in place,
      // and Anthropic rotates the refresh token when it does -- so without a way
      // to write the result back, the copy resolved above is dead the moment
      // this run refreshes it and every later run fails with "Login expired ·
      // Please run /login". Best-effort by design: no grant simply means no
      // write-back.
      if (provider === "claude-remote" && this.deps.claudeRemoteWriteback) {
        // Same canonical subject the credential was READ from above -- a grant
        // minted against the raw subject would write the refreshed credentials
        // to a record nothing ever reads, and the shared one would keep serving
        // the pre-refresh copy until it died.
        const grant = await this.deps.claudeRemoteWriteback.createWritebackGrant(
          credentialSubject,
          (this.deps.agentRunTimeoutSeconds ?? 0) + WRITEBACK_GRANT_MARGIN_SECONDS,
        );
        if (grant) {
          secretEnv = [
            ...secretEnv,
            { name: CREDENTIALS_WRITEBACK_ENV.url, value: grant.url },
            { name: CREDENTIALS_WRITEBACK_ENV.token, value: grant.token },
          ];
        }
      }
    }

    // ── Batch pre-flight verdict (docs/adr/0030 §4) ─────────────────────────
    // One decision point for the whole provider set, reached only after every
    // provider has been assessed.
    if (pendingLinks.length > 0 || failedToStart.length > 0) {
      this.logVerdict("link-required", agent.id, {
        pending: pendingLinks.map((l) => `${l.provider}@${l.pending.subject}`),
        failedToStart,
      });
      return {
        kind: "link-required",
        message: this.composeLinkRequiredMessage(pendingLinks, failedToStart),
        // `pending` still carries ONE entry: it is the resume anchor that
        // checkPendingIdentityLink, the terminal /invoke record and
        // integration-gateway's waitAndResume all key off, and widening that
        // contract is a separate change. Re-entering the gate re-assesses every
        // provider anyway, so whichever links the user completed are resolved on
        // the next turn and only genuinely-missing ones re-prompt.
        ...(pendingLinks[0] ? { pending: pendingLinks[0].pending } : {}),
      };
    }

    // ── Sealed actor context (docs/adr/0030 §5) ────────────────────────────
    // The agent receives WHO the caller is, resolved here, so it never performs
    // identity lookups of its own. `identityDelegation.ts` was calling GitHub's
    // /user with the injected token and failing 401; with this present it skips
    // that call entirely, so the failure mode is removed by construction rather
    // than debugged.
    //
    // Login only, no numeric id: the id would require the /user round trip this
    // exists to eliminate, and the co-author trailer degrades to the login-only
    // form without it.
    const actorLogin =
      actorLoginFromLoop ??
      principalLogin ??
      (await resolveActorLogin(identity.subject, req.senderLogin, this.deps.identityLinkGateway));
    if (actorLogin) {
      secretEnv = [...(secretEnv ?? []), { name: ACTOR_LOGIN_ENV, value: actorLogin }];
    }

    this.logVerdict("authorized", agent.id, {
      // NAMES only. This is the one place that holds every resolved credential
      // for a run, so it is also the one place a careless log would dump all of
      // them at once.
      injecting: (secretEnv ?? []).map((e) => e.name),
      actorLogin: actorLogin ?? null,
      principal,
    });
    return {
      kind: "authorized",
      ...(secretEnv ? { secretEnv } : {}),
      ...(actorLogin ? { actorLogin } : {}),
      principal,
    };
  }

  /**
   * One line per authorization decision, at every exit.
   *
   * Deliberately permanent, and deliberately at the verdict rather than
   * scattered through the provider loop. The three `[identity-gate-debug]`
   * console.logs this replaces were marked "remove once root-caused", and
   * removing them immediately cost the ability to tell "the gate parked" from
   * "the gate cleared but nothing launched" in an e2e failure -- with no logs at
   * all, a spec that times out waiting for an AgentRun looks identical whether
   * authorization refused, the launch threw, or the relay never arrived.
   *
   * Values are never logged; `injecting` is names only.
   */
  private logVerdict(kind: string, agentId: string, detail: Record<string, unknown>): void {
    console.log("[authorization]", JSON.stringify({ verdict: kind, agentId, ...detail }));
  }

  /**
   * READ-ONLY credential resolution: resolve what is already linked, and never
   * start a link flow.
   *
   * The agent-backed-tool path (a Skill reaching an Agent through an ordinary
   * tool call) needs the same keying and the same provider->env mapping as
   * {@link authorize}, but deliberately cannot start a link: there is no session
   * slot analogous to `pendingIdentityLink` for a paused TOOL call, only for a
   * paused agent delegation. That is a documented v1 scope cut, not an
   * oversight, so it gets its own entry point rather than a flag on `authorize`
   * -- a boolean there would make "does calling this start an OAuth flow?"
   * depend on an argument, which is precisely the ambiguity §1 is about.
   *
   * Reporting the offending provider instead of a message: the caller's error
   * text names the TOOL, which this class has no business knowing.
   */
  async resolveLinkedCredentials(input: {
    identity: Identity;
    identityProviders?: string[];
  }): Promise<
    | { kind: "resolved"; secretEnv?: CredentialEnvEntry[] }
    | { kind: "gateway-missing"; provider: string }
    | { kind: "not-linked"; provider: string }
    | { kind: "unsupported-provider"; provider: string }
  > {
    let secretEnv: CredentialEnvEntry[] | undefined;
    for (const provider of input.identityProviders ?? []) {
      const gateway = this.gatewayFor(provider);
      if (!gateway) return { kind: "gateway-missing", provider };
      // Same keying as authorize()'s gate -- deriving a different subject here
      // would report "not linked" for an account the user had in fact just
      // linked, which is the PR #144 re-auth loop.
      const credentialSubject = CROSS_ENTRY_POINT_PROVIDERS.has(provider)
        ? (input.identity.principal ?? input.identity.subject)
        : input.identity.subject;
      const existing = await gateway.getToken(provider, credentialSubject);
      if (!existing) return { kind: "not-linked", provider };
      const envVarName = PROVIDER_ENV_VAR[provider];
      if (!envVarName) return { kind: "unsupported-provider", provider };
      secretEnv = [...(secretEnv ?? []), { name: envVarName, value: existing.token }];
    }
    return { kind: "resolved", ...(secretEnv ? { secretEnv } : {}) };
  }

  /**
   * The whole user-facing message for a `link-required` verdict: every
   * outstanding link plus every failed start, in one turn's worth of text.
   */
  private composeLinkRequiredMessage(
    pendingLinks: { label: string; linkUrlText: string; surfacedLive: boolean }[],
    failedToStart: string[],
  ): string {
    const parts: string[] = [];

    if (pendingLinks.length > 0) {
      // Anything already surfaced live via progressListener is not repeated
      // here -- otherwise a streaming caller renders the same link twice.
      const toPrint = pendingLinks.filter((l) => !l.surfacedLive);
      if (toPrint.length === 1) {
        parts.push(`To continue, please ${toPrint[0]!.linkUrlText}. This is a one-time step -- send any message once you're done.`);
      } else if (toPrint.length > 1) {
        parts.push(
          `To continue, I need you to link ${toPrint.length} accounts (one-time). Please ${toPrint
            .map((l) => l.linkUrlText)
            .join(", and ")}. Send any message once you're done.`,
        );
      } else {
        parts.push(
          pendingLinks.length === 1
            ? `I haven't received your ${pendingLinks[0]!.label} account link yet. Send any message once you're done and I'll continue.`
            : `I haven't received your ${pendingLinks.map((l) => l.label).join(" and ")} account links yet. Send any message once you're done and I'll continue.`,
        );
      }
    }

    if (failedToStart.length > 0) {
      // Reported ALONGSIDE the links rather than instead of them: a provider
      // whose start failed must not hide the ones that succeeded, which is
      // exactly the coupling ADR 0030 removes.
      //
      // "also" only when something precedes it -- when every provider failed to
      // start there is no preceding clause, and the message has to stand on its
      // own.
      const labels = failedToStart.join(" and ");
      parts.push(
        parts.length > 0
          ? `I also couldn't start the ${labels} linking step just now -- try again in a moment and I'll retry that part.`
          : `I couldn't start the one-time ${labels} account-linking step just now. Please try again in a moment -- re-apply the label or send any message and I'll retry.`,
      );
    }

    return parts.join(" ");
  }
}
