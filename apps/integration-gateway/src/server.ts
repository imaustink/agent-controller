import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  buildCronEnvelope,
  buildWebhookEnvelope,
  evaluate,
  normalizeHeaders,
  parseBody,
  type Envelope,
  type JsonValue,
  type RenderedReply,
} from "@controller-agent/event-triggers";
import type { GithubReplyClient } from "./github-client.js";
import type { GithubDeviceFlowLinker } from "./identity-link/device-flow-linker.js";
import { IdentityLinkApi } from "./identity-link/api.js";
import type { OAuthAuthCodeLinker } from "./identity-link/oauth-authcode-linker.js";
import { ClaudeAuthApi } from "./claude-auth/api.js";
import { ConnectionsApi } from "./connections/api.js";
import type { OidcLoginClient } from "./connections/oidc-login.js";
import type { PrincipalDirectory } from "./connections/principal-directory.js";
import { buildConnectionProviders } from "./connections/providers.js";
import type { IdentityLinkStore } from "./identity-link/store.js";
import type { ClaudeSetupTokenFlows } from "./claude-auth/pty-setup-token.js";
import type { ClaudeLoginFlows } from "./claude-auth/pty-login.js";
import type { ClaudeTokenStore } from "./claude-auth/store.js";
import type { IdentityResolver, RepoContext } from "./identity.js";
import type {
  AcceptedTrigger,
  OrchestratorClient,
  OrchestratorInvokeResult,
  PollHooks,
} from "./orchestrator-client.js";
import { ClaudeCredentialRefresher, ClaudeCredentialSweeper } from "./claude-auth/credential-refresher.js";
import { renderSessionPage } from "./session-page.js";
import type { SessionPageStore } from "./session-page-store.js";
import { tickUsername, type TokenAuthenticator } from "./tick-auth.js";
import { LabelReconciler, type PendingLabelStore } from "./label-reconciler.js";
import { couldMatchBeforeSender, type EventTriggerLookup } from "./event-triggers.js";
import {
  StaticEventSourceRegistry,
  type CompiledEventSource,
  type CompiledSender,
  type EventSourceLookup,
  type SecretLookup,
} from "./event-sources.js";
import {
  constantTimeEquals,
  slackUrlVerificationChallenge,
  verifyHeaderName,
  verifyWebhookRequest,
} from "./webhooks/verify.js";

const SESSION_PAGE_PATH = /^\/sessions\/([^/]+)$/;
const SESSION_PROMPT_PATH = /^\/sessions\/([^/]+)\/prompts$/;
const SESSION_LIVE_EVENTS_PATH = /^\/sessions\/([^/]+)\/live-events$/;
const SESSION_LIVE_PROMPT_PATH = /^\/sessions\/([^/]+)\/live-prompt$/;
const WEBHOOK_PATH = /^\/webhooks\/([^/]+)$/;
const TICK_PATH = /^\/events\/([^/]+)\/tick$/;
/** A Kubernetes object name (DNS subdomain) -- anything else cannot name an EventSource, so it is a 404 without a lookup. */
const SOURCE_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
/**
 * Upper bound on a webhook body, buffered in full BEFORE verification (the
 * signature covers the raw bytes). Matches GitHub's own 25 MB payload cap; an
 * unauthenticated sender can't make the gateway buffer more than this.
 */
const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;
/** A bearer that could be a Kubernetes JWT; anything else is refused without being verified. */
const BEARER_JWT = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
/** Header carrying `sha256=<hex hmac(body)>` on a signed `reply.http` POST. */
export const EVENT_SIGNATURE_HEADER = "x-event-signature";
const HTTP_REPLY_TIMEOUT_MS = 10_000;

export interface GatewayServerOptions {
  /**
   * The `EventSource` table (ADR 0048): which `/webhooks/:source` and
   * `/events/:source/tick` routes exist and how each is verified. Absent ->
   * no sources, every event route 404s.
   */
  eventSources?: EventSourceLookup;
  /**
   * A read-only view of the `EventTrigger`s, consulted ONLY to skip sender
   * resolution (live GitHub API calls) for a delivery no trigger could match
   * -- see event-triggers.ts. Matching stays the orchestrator's. Absent, or
   * not loaded yet -> every sender is resolved, as if there were no view.
   */
  eventTriggers?: EventTriggerLookup;
  /**
   * Reads the Secrets that `verify.secretRef` and a trigger's
   * `reply.http.secretRef` name (in the CRD namespace). Absent -> every lookup is "missing", so verification fails
   * closed (401) and signed HTTP replies are not sent.
   */
  secrets?: SecretLookup;
  /**
   * Reviews a cron tick's ServiceAccount token (docs/event-triggers.md §8).
   * Absent (or no `tickNamespace`) -> every tick is 401.
   */
  tickAuthenticator?: TokenAuthenticator;
  /** Namespace the cron sources' ServiceAccounts live in -- the CRD namespace. */
  tickNamespace?: string;
  /** Maps a source's sender login to an identity; only a login it resolves is ever forwarded. */
  identityResolver: IdentityResolver;
  orchestratorClient: OrchestratorClient;
  githubReplyClient: GithubReplyClient;
  /** `fetch` used for `reply.http` deliveries; injectable for tests. */
  replyFetch?: typeof fetch;
  /** Operational log lines (drops, ignored events, rejected verifications). Defaults to console.error. Never given secrets. */
  log?: (line: string) => void;
  /** Injectable clock (Slack timestamp window, envelope time). */
  now?: () => Date;
  /** Called with any error from the background invoke-and-reply step; defaults to console.error. */
  onBackgroundError?: (error: unknown) => void;
  /**
   * The identity-link credential-broker API (docs on `IdentityLinkApi`) --
   * optional so deployments/tests that don't use it needn't wire it up. Both
   * fields must be set together to enable `/identity-link/*`.
   */
  identityLinkLinker?: GithubDeviceFlowLinker;
  identityLinkToken?: string;
  /**
   * Authorization-code providers beyond GitHub, keyed by name (docs/adr/0040
   * needs Atlassian). Absent in a deployment that links only GitHub, where
   * behaviour is exactly what it was.
   */
  identityLinkAuthCodeLinkers?: ReadonlyMap<string, OAuthAuthCodeLinker>;
  /**
   * Per-user Claude Code OAuth `setup-token` flow (docs/adr/0027) -- a
   * sibling to identity-link above, but PTY-driven rather than an HTTP
   * device flow. All three must be set together (mirroring
   * `identityLinkLinker`/`identityLinkToken`'s pairing) to enable
   * `/claude-auth/*`; reuses `identityLinkToken` as its own bearer secret
   * rather than minting a new one. Requires `publicBaseUrl` (below) to be
   * set too, since the page link handed back needs a reachable host.
   */
  claudeAuthFlows?: ClaudeSetupTokenFlows;
  claudeAuthStore?: ClaudeTokenStore;
  /**
   * How long a PARKED turn is held open waiting for the caller to finish
   * linking, before giving up. Absent -> {@link
   * GatewayServer.DEFAULT_RESUME_WAIT_MS}. Short values are appropriate wherever
   * turns park routinely rather than exceptionally (see that constant).
   */
  resumeWaitMs?: number;
  /**
   * Full-login (`claude auth login --claudeai`) flows for Remote Control
   * (docs/adr/0027 follow-up) -- optional and additive alongside
   * `claudeAuthFlows` above: a subject's `mode=login` request 501s until this
   * is wired up, rather than falling back to `setup-token`.
   */
  claudeLoginFlows?: ClaudeLoginFlows;
  /**
   * Off switch for refreshing stored `login` credentials before serving them
   * (credential-refresher.ts). Defaults to on. Turning it off restores the
   * behaviour where only a run's own CLI ever refreshes -- which is what made
   * a link depend on every pod reporting back.
   */
  claudeCredentialRefreshEnabled?: boolean;
  /** How close to expiry a stored credential must be before it is refreshed on read. */
  claudeCredentialRefreshMarginMs?: number;
  /** How often the background sweep renews stored credentials nothing is reading. */
  claudeCredentialSweepIntervalMs?: number;
  /**
   * How close to expiry a credential must be for the SWEEP to renew it --
   * deliberately wider than the on-read margin, since the sweep's job is that a
   * link is never found dead rather than that one blob is usable right now.
   */
  claudeCredentialSweepMarginMs?: number;
  /**
   * Session-page feature (issue #81) -- both fields must be set together to
   * enable it: a trigger whose `reply.github.sessionPage` is set gets a link
   * to a minimal `GET /sessions/:token` page appended to its ack comment,
   * showing that session's turn history and accepting follow-up prompts.
   * Omitted entirely, no page routes are reachable and no link is posted.
   */
  sessionPageStore?: SessionPageStore;
  publicBaseUrl?: string;
  /**
   * The Connections page (docs/adr/0046). Requires identity-link
   * (`identityLinkLinker`/`identityLinkToken`) and `publicBaseUrl`; ignored
   * without them. Absent keeps every route exactly as before.
   */
  connections?: {
    store: IdentityLinkStore;
    directory: PrincipalDirectory;
    oidc: OidcLoginClient;
    cookieKey: Buffer;
    sessionTtlMs: number;
    /** Whether GitHub's authcode flow is configured -- the page cannot run the device flow. */
    githubAuthCode: boolean;
  };
  /**
   * Durable outbox of `reply.github.removeLabel` removals still owed, enabling
   * the self-healing reconciler (label-reconciler.ts). Optional and additive:
   * when absent, label removal works exactly the same (the in-process
   * `finally`), just without the restart-surviving backstop.
   */
  pendingLabelStore?: PendingLabelStore;
  /** How often the reconciling sweep runs; forwarded to {@link LabelReconciler}. */
  labelReconcilerIntervalMs?: number;
  /** How old an owed removal must be before the sweep acts on it; forwarded to {@link LabelReconciler}. */
  labelReconcilerGraceMs?: number;
}

/** The validated `reply.github` of an accepted trigger, with its repository split. */
interface GithubReplyTarget {
  owner: string;
  repo: string;
  issueNumber: number;
  ack?: string;
  sessionPage?: boolean;
  result?: boolean;
  removeLabel?: string;
}

/** `owner/name`, each a GitHub-legal segment -- what lands in a REST path. */
const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

class BodyTooLargeError extends Error {}

/**
 * The integration gateway's HTTP surface. Its event half (ADR 0048,
 * docs/event-triggers.md §7) is generic: `POST /webhooks/:source` verifies a
 * request against its `EventSource` BEFORE parsing it, normalizes it into the
 * envelope, optionally verifies who sent it, and relays it to the
 * orchestrator's `/invoke`; `POST /events/:source/tick` does the same for a
 * cron source's CronJob. The gateway does no filtering of its own -- whether an
 * event does anything is decided by the orchestrator's EventTriggers -- and
 * the only side effects it runs are the ones the matched trigger's `reply`
 * declares (GitHub ack/result/label removal, an HTTP callback).
 */
export class GatewayServer {
  private server: Server | undefined;
  private readonly identityLinkApi: IdentityLinkApi | undefined;
  private readonly claudeAuthApi: ClaudeAuthApi | undefined;
  private readonly connectionsApi: ConnectionsApi | undefined;
  private readonly claudeCredentialSweeper: ClaudeCredentialSweeper | undefined;
  private readonly labelReconciler: LabelReconciler | undefined;
  private readonly eventSources: EventSourceLookup;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly report: (error: unknown) => void;

  constructor(private readonly options: GatewayServerOptions) {
    this.eventSources = options.eventSources ?? new StaticEventSourceRegistry();
    this.log = options.log ?? ((line) => console.error(line));
    this.now = options.now ?? (() => new Date());
    this.report = options.onBackgroundError ?? ((error: unknown) => console.error(error));
    this.identityLinkApi =
      options.identityLinkLinker && options.identityLinkToken
        ? new IdentityLinkApi(
            options.identityLinkLinker,
            options.identityLinkToken,
            options.identityLinkAuthCodeLinkers,
          )
        : undefined;
    const refresher = options.claudeAuthStore
      ? new ClaudeCredentialRefresher({
          store: options.claudeAuthStore,
          enabled: options.claudeCredentialRefreshEnabled ?? true,
          ...(options.claudeCredentialRefreshMarginMs ? { marginMs: options.claudeCredentialRefreshMarginMs } : {}),
        })
      : undefined;
    this.claudeAuthApi =
      options.claudeAuthFlows && options.claudeAuthStore && options.identityLinkToken && options.publicBaseUrl
        ? new ClaudeAuthApi(
            options.claudeAuthFlows,
            options.claudeAuthStore,
            options.identityLinkToken,
            options.publicBaseUrl,
            options.claudeLoginFlows,
            // Refresh a near-expiry `login` credential before handing it to a
            // run, in ONE serialized place. Previously the only thing that ever
            // refreshed was a run's own in-pod CLI, which made the stored copy
            // dependent on that pod reporting back, and left an unexercised
            // link to age out on its own.
            refresher,
          )
        : undefined;
    const connections = options.connections;
    if (connections && this.identityLinkApi && options.identityLinkToken && options.publicBaseUrl) {
      const claudeAuthApi = this.claudeAuthApi;
      const connectionsApi = new ConnectionsApi({
        providers: buildConnectionProviders({
          store: connections.store,
          ...(connections.githubAuthCode && options.identityLinkLinker ? { githubLinker: options.identityLinkLinker } : {}),
          ...(options.identityLinkAuthCodeLinkers ? { authCodeLinkers: options.identityLinkAuthCodeLinkers } : {}),
          ...(claudeAuthApi && options.claudeAuthStore
            ? {
                claude: {
                  store: options.claudeAuthStore,
                  start: (subject, kind) => claudeAuthApi.startPageFlow(subject, kind),
                  loginEnabled: Boolean(options.claudeLoginFlows),
                },
              }
            : {}),
        }),
        directory: connections.directory,
        oidc: connections.oidc,
        cookieKey: connections.cookieKey,
        internalToken: options.identityLinkToken,
        publicBaseUrl: options.publicBaseUrl,
        sessionTtlMs: connections.sessionTtlMs,
      });
      const back = connectionsApi.completionRedirect.bind(connectionsApi);
      this.identityLinkApi.completionRedirect = back;
      this.identityLinkApi.cancelRedirect = connectionsApi.cancelRedirect.bind(connectionsApi);
      if (claudeAuthApi) claudeAuthApi.completionRedirect = back;
      this.connectionsApi = connectionsApi;
    }
    // The sweep renews credentials nothing is currently asking for, which is
    // the only thing that keeps an UNUSED link alive -- refresh-on-read above
    // fires only when something reads. Shares the refresher, so a sweep and a
    // concurrent launch collapse onto one refresh per subject rather than
    // rotating each other's token out.
    this.claudeCredentialSweeper =
      refresher && options.claudeAuthStore && (options.claudeCredentialRefreshEnabled ?? true)
        ? new ClaudeCredentialSweeper({
            store: options.claudeAuthStore,
            refresher,
            ...(options.claudeCredentialSweepIntervalMs ? { intervalMs: options.claudeCredentialSweepIntervalMs } : {}),
            ...(options.claudeCredentialSweepMarginMs ? { marginMs: options.claudeCredentialSweepMarginMs } : {}),
          })
        : undefined;
    // Durable self-heal for a trigger-declared label whose in-process `finally`
    // was lost to a mid-turn pod restart/OOM. Only built when a pending-label
    // store is wired; a run that is no longer live (orchestrator liveness
    // probe) and that THIS gateway recorded is treated as terminal and its
    // label removed.
    this.labelReconciler = options.pendingLabelStore
      ? new LabelReconciler({
          store: options.pendingLabelStore,
          // `probeLive`, NOT `checkLive`: a run is terminal ONLY on a POSITIVE
          // confirmed not-live answer. A transient probe failure (orchestrator
          // blip/rollout -> network error or non-ok) reads as "unknown", which
          // is treated as still-live here so a label is never stripped mid-run
          // on a run that is merely unreachable (that would let a re-applied
          // label spawn a duplicate run).
          isRunTerminal: async (sessionId) => (await options.orchestratorClient.probeLive(sessionId)).status === "not-live",
          removeLabel: (owner, repo, issueNumber, label) =>
            options.githubReplyClient.removeIssueLabel(owner, repo, issueNumber, label),
          onError: this.report,
          ...(options.labelReconcilerIntervalMs ? { intervalMs: options.labelReconcilerIntervalMs } : {}),
          ...(options.labelReconcilerGraceMs !== undefined ? { graceMs: options.labelReconcilerGraceMs } : {}),
        })
      : undefined;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error: unknown) => {
          console.error(error);
          if (!res.headersSent) res.writeHead(500);
          if (!res.writableEnded) res.end();
        });
      });
      this.claudeCredentialSweeper?.start();
      // Fires one sweep immediately -- the startup self-heal for any label
      // stranded by the previous pod dying mid-turn -- then on its interval.
      this.labelReconciler?.start();
      this.server.listen(port, resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.claudeCredentialSweeper?.stop();
      this.labelReconciler?.stop();
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    const webhookMatch = req.method === "POST" ? WEBHOOK_PATH.exec(url.pathname) : null;
    if (webhookMatch) {
      await this.handleWebhook(req, res, webhookMatch[1] as string);
      return;
    }
    const tickMatch = req.method === "POST" ? TICK_PATH.exec(url.pathname) : null;
    if (tickMatch) {
      await this.handleTick(req, res, tickMatch[1] as string);
      return;
    }
    if (this.options.sessionPageStore) {
      const liveEventsMatch = req.method === "GET" ? SESSION_LIVE_EVENTS_PATH.exec(url.pathname) : null;
      if (liveEventsMatch) {
        await this.handleSessionLiveEvents(res, liveEventsMatch[1] as string);
        return;
      }
      const livePromptMatch = req.method === "POST" ? SESSION_LIVE_PROMPT_PATH.exec(url.pathname) : null;
      if (livePromptMatch) {
        await this.handleSessionLivePrompt(req, res, livePromptMatch[1] as string);
        return;
      }
      const pageMatch = req.method === "GET" ? SESSION_PAGE_PATH.exec(url.pathname) : null;
      if (pageMatch) {
        await this.handleSessionPage(res, pageMatch[1] as string);
        return;
      }
      const promptMatch = req.method === "POST" ? SESSION_PROMPT_PATH.exec(url.pathname) : null;
      if (promptMatch) {
        await this.handleSessionPrompt(req, res, promptMatch[1] as string);
        return;
      }
    }
    if (this.connectionsApi && (await this.connectionsApi.handle(req, res, url))) {
      return;
    }
    // The authcode callback route is intercepted BEFORE the bearer-gated
    // dispatch below -- it's hit directly by the end user's browser (via
    // GitHub's redirect), which cannot carry our internal bearer token, and
    // `identityLinkApi.handle`'s own bearer check would otherwise 401 it.
    if (this.identityLinkApi && (await this.identityLinkApi.handleCallback(req, res, url))) {
      return;
    }
    // Same reasoning as the identity-link callback above: the claude-auth
    // page/submit routes are hit directly by the human's browser (capability
    // via `flowId` in the URL, not a bearer token), so they must be
    // dispatched before `claudeAuthApi.handle`'s bearer check.
    if (this.claudeAuthApi && (await this.claudeAuthApi.handlePage(req, res, url))) {
      return;
    }
    if (this.claudeAuthApi && (await this.claudeAuthApi.handle(req, res, url))) {
      return;
    }
    if (this.identityLinkApi && (await this.identityLinkApi.handle(req, res, url))) {
      return;
    }
    res.writeHead(404).end();
  }

  /** The source a route names, or undefined (-> 404) for an unknown, unusable or wrongly-kinded one. */
  private lookupSource(rawName: string, kind: CompiledEventSource["kind"]): CompiledEventSource | undefined {
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return undefined;
    }
    if (!SOURCE_NAME.test(name)) return undefined;
    const source = this.eventSources.get(name);
    return source && source.kind === kind ? source : undefined;
  }

  /**
   * `POST /webhooks/:source` (docs/event-triggers.md §7). Order matters and
   * is the security argument for this handler:
   *
   *  1. 404 for an unknown or non-webhook source, before reading anything.
   *  2. Buffer the raw bytes (bounded) and VERIFY them -- 401 on failure.
   *     Nothing has been parsed, no CEL has run, nothing has been relayed.
   *  3. Only then parse, answer Slack's url_verification handshake inline,
   *     and ack 202 -- senders have short delivery timeouts, so identity
   *     resolution and the relay run after the response.
   */
  private async handleWebhook(req: IncomingMessage, res: ServerResponse, rawName: string): Promise<void> {
    const source = this.lookupSource(rawName, "webhook");
    if (!source || source.kind !== "webhook") {
      res.writeHead(404).end();
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBodyBuffer(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        res.writeHead(413, { connection: "close" }).end();
        return;
      }
      throw error;
    }

    const verify = source.webhook.verify;
    const receivedAt = this.now();
    let verdict = verifyWebhookRequest(
      verify,
      await this.readSecret(verify.secretRef.name, verify.secretRef.key),
      req.headers,
      rawBody,
      receivedAt,
    );
    if (!verdict.ok) {
      // One forced re-read before rejecting, so a just-rotated Secret is
      // honoured without waiting out the cache TTL. The reader rate-limits
      // forced re-reads, so a flood of bad signatures can't become a flood of
      // API calls.
      const fresh = await this.readSecret(verify.secretRef.name, verify.secretRef.key, true);
      verdict = verifyWebhookRequest(verify, fresh, req.headers, rawBody, receivedAt);
    }
    if (!verdict.ok) {
      this.log(`webhook ${source.name}: rejected, verification failed (${verdict.reason})`);
      res.writeHead(401).end();
      return;
    }

    const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined;
    const body = parseBody(rawBody, contentType);

    if (verify.scheme === "slackV0") {
      // Slack's endpoint handshake is answered synchronously and is not an
      // event -- nothing is relayed. It is still verified first: Slack signs
      // it like any other request.
      const challenge = slackUrlVerificationChallenge(body);
      if (challenge !== undefined) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge }));
        return;
      }
    }

    // The verify header never reaches the envelope (normalizeHeaders also
    // always drops authorization and cookie): a signature or shared secret has
    // no business in CEL, the orchestrator, or an agent's prompt.
    const headers = normalizeHeaders(req.headers, [verifyHeaderName(verify)]);
    const deliveryHeader = source.webhook.deliveryIdHeader?.toLowerCase();
    const id = (deliveryHeader ? headers[deliveryHeader] : undefined) || randomUUID();

    res.writeHead(202).end();

    this.ingestWebhook(source, { id, headers, body, receivedAt }).catch(this.report);
  }

  private async ingestWebhook(
    source: Extract<CompiledEventSource, { kind: "webhook" }>,
    input: { id: string; headers: Record<string, string>; body: JsonValue; receivedAt: Date },
  ): Promise<void> {
    let senderLogin: string | undefined;
    let sender: Envelope["sender"] | undefined;
    let repository: string | undefined;
    if (source.sender) {
      const preliminary = buildWebhookEnvelope({ source: source.name, ...input, now: input.receivedAt });
      // Resolving a sender costs GitHub API calls; most deliveries (push,
      // check_run, ...) can't fire any trigger, so they stop here, before
      // spending any. Only ever drops -- an event that survives is still
      // verified below and matched by the orchestrator.
      const triggers = this.options.eventTriggers?.all();
      if (triggers && !couldMatchBeforeSender(triggers, preliminary)) {
        this.log(`webhook ${source.name} event ${input.id}: no trigger could match (ignored before sender lookup)`);
        return;
      }
      const resolved = await this.resolveSender(source.sender, preliminary);
      if (!resolved.ok) {
        // 202 already sent: a dropped event is not the sender's error, and a
        // non-2xx would only make it retry the same drop.
        this.log(`webhook ${source.name} event ${input.id}: dropped (${resolved.reason})`);
        return;
      }
      senderLogin = resolved.login;
      sender = { login: resolved.login, isBot: resolved.isBot };
      repository = resolved.repository;
    }
    // A source without `sender` forwards NO login: the run has no per-user
    // principal and acts as the gateway's own service identity.
    const envelope = buildWebhookEnvelope({
      source: source.name,
      ...input,
      ...(sender ? { sender } : {}),
      ...(repository ? { repository } : {}),
      now: input.receivedAt,
    });
    await this.relayEvent(envelope, senderLogin);
  }

  /**
   * Evaluates the source's sender expressions against the preliminary
   * envelope (sender {} / repository "") and has the provider VERIFY the
   * login. Every failure -- an expression error, a wrong type, a bot, a login
   * the provider doesn't recognize -- drops the event: what comes out of here
   * selects whose credentials a run gets, so "couldn't tell" never means "let
   * it through".
   */
  private async resolveSender(
    sender: CompiledSender,
    preliminary: Envelope,
  ): Promise<{ ok: true; login: string; isBot: boolean; repository: string } | { ok: false; reason: string }> {
    const login = evaluate(sender.loginFrom, preliminary);
    if (!login.ok) return { ok: false, reason: `sender.loginFrom failed: ${login.error}` };
    if (typeof login.value !== "string" || !login.value) return { ok: false, reason: "sender.loginFrom is not a non-empty string" };

    let isBot = false;
    if (sender.isBotFrom) {
      const r = evaluate(sender.isBotFrom, preliminary);
      if (!r.ok) return { ok: false, reason: `sender.isBotFrom failed: ${r.error}` };
      if (typeof r.value !== "boolean") return { ok: false, reason: "sender.isBotFrom is not a bool" };
      isBot = r.value;
    }

    let repository = "";
    if (sender.repositoryFrom) {
      const r = evaluate(sender.repositoryFrom, preliminary);
      if (!r.ok) return { ok: false, reason: `sender.repositoryFrom failed: ${r.error}` };
      if (typeof r.value !== "string") return { ok: false, reason: "sender.repositoryFrom is not a string" };
      repository = r.value;
    }

    // Self-trigger guard: the agent's own comments/labels come from a bot.
    if (isBot && sender.dropBots) return { ok: false, reason: `sender ${login.value} is a bot` };

    const repoMatch = REPOSITORY.exec(repository);
    const repoContext: RepoContext | undefined = repoMatch ? { owner: repoMatch[1] as string, repo: repoMatch[2] as string } : undefined;
    const identity = await this.options.identityResolver.resolve(login.value, isBot, repoContext);
    if (!identity) return { ok: false, reason: `sender ${login.value} not verified by provider ${sender.provider}` };
    return { ok: true, login: login.value, isBot, repository };
  }

  /**
   * `POST /events/:source/tick` -- a cron source's CronJob (docs/event-triggers.md
   * §8). Authenticated FIRST (so an unauthenticated caller can't probe which
   * sources exist): the bearer must review as THIS source's ServiceAccount, so
   * one source's identity can never tick another. Then 404 unless the source
   * is cron. The payload comes from the CR, never from the tick: the token
   * proves "it's time", not "here is what to do".
   */
  private async handleTick(req: IncomingMessage, res: ServerResponse, rawName: string): Promise<void> {
    req.resume(); // the tick carries no body we use
    if (!(await this.tickAuthorized(req.headers.authorization, rawName))) {
      this.log("event tick rejected: bearer is not this source's ServiceAccount");
      res.writeHead(401).end();
      return;
    }
    const source = this.lookupSource(rawName, "cron");
    if (!source || source.kind !== "cron") {
      res.writeHead(404).end();
      return;
    }
    const envelope = buildCronEnvelope({ source: source.name, ...(source.cron.payload !== undefined ? { payload: source.cron.payload } : {}), now: this.now() });
    res.writeHead(202).end();
    this.relayEvent(envelope, undefined).catch(this.report);
  }

  private async tickAuthorized(authorization: string | undefined, rawName: string): Promise<boolean> {
    const { tickAuthenticator, tickNamespace } = this.options;
    if (!tickAuthenticator || !tickNamespace || typeof authorization !== "string") return false;
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return false;
    }
    // Shape checks first, so junk never costs an API round trip.
    const bearer = BEARER_JWT.exec(authorization);
    if (!bearer || !SOURCE_NAME.test(name)) return false;
    const username = await tickAuthenticator.authenticate(bearer[1] as string);
    return username === tickUsername(tickNamespace, name);
  }

  private async readSecret(name: string, key: string, refresh = false): Promise<string | undefined> {
    if (!this.options.secrets) return undefined;
    try {
      return await this.options.secrets.get(name, key, refresh ? { refresh: true } : undefined);
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /**
   * Sends the envelope to `/invoke` and handles the three §5 outcomes. Only
   * an accepted event has side effects, and only the ones its trigger's
   * `reply` declares.
   */
  private async relayEvent(envelope: Envelope, senderLogin: string | undefined): Promise<void> {
    const submitted = await this.options.orchestratorClient.submitEvent(envelope, senderLogin);
    switch (submitted.kind) {
      case "ignored":
        this.log(`event ${envelope.source}/${envelope.id}: no trigger matched (ignored)`);
        return;
      case "rejected":
        this.log(`event ${envelope.source}/${envelope.id}: trigger matched but failed for this event (422): ${submitted.error}`);
        return;
      case "failed":
        this.log(`event ${envelope.source}/${envelope.id}: relay failed: ${submitted.error}`);
        return;
      case "accepted":
        await this.runAcceptedEvent(envelope, senderLogin, submitted.id, submitted.trigger);
        return;
    }
  }

  /** Validates `reply.github` from the orchestrator; an unusable one is logged and treated as absent (it would only produce 404s against a garbage path). */
  private githubReplyTarget(trigger: AcceptedTrigger): GithubReplyTarget | undefined {
    const gh = trigger.reply?.github;
    if (!gh) return undefined;
    const repoMatch = typeof gh.repository === "string" ? REPOSITORY.exec(gh.repository) : null;
    const issueNumber = gh.issueNumber;
    if (!repoMatch || typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      this.log(`trigger ${trigger.name}: reply.github ignored (repository ${JSON.stringify(gh.repository)} / issueNumber ${JSON.stringify(issueNumber)} unusable)`);
      return undefined;
    }
    return {
      owner: repoMatch[1] as string,
      repo: repoMatch[2] as string,
      issueNumber,
      ...(gh.ack ? { ack: gh.ack } : {}),
      ...(gh.sessionPage ? { sessionPage: true } : {}),
      ...(gh.result ? { result: true } : {}),
      ...(gh.removeLabel ? { removeLabel: gh.removeLabel } : {}),
    };
  }

  /**
   * One accepted event, start to finish (docs/event-triggers.md §7):
   *
   *   record owed label removal -> ack (+ session page link) -> poll
   *   -> result comment -> http reply -> remove label (always)
   *
   * Every side effect is best effort and reported, never thrown: a failed ack
   * must not stop the run being tracked, and a failed comment must not keep the
   * label on or the HTTP callback from firing.
   */
  private async runAcceptedEvent(
    envelope: Envelope,
    senderLogin: string | undefined,
    invocationId: string,
    trigger: AcceptedTrigger,
  ): Promise<void> {
    const gh = this.githubReplyTarget(trigger);
    const http = trigger.reply?.http;
    const sessionId = trigger.sessionId;
    const label = gh?.removeLabel;
    const best = async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        this.report(error);
      }
    };
    let httpSent = false;
    try {
      // Record the owed removal BEFORE polling (and before anything else that
      // can throw or outlive the pod), so the reconciler can self-heal it if
      // the `finally` below never runs.
      if (gh && label && this.options.pendingLabelStore) {
        const store = this.options.pendingLabelStore;
        await best(() =>
          store.record({ owner: gh.owner, repo: gh.repo, issueNumber: gh.issueNumber, label, sessionId, recordedAt: Date.now() }),
        );
      }

      if (gh) {
        let pageUrl: string | undefined;
        if (gh.sessionPage && this.options.sessionPageStore && this.options.publicBaseUrl) {
          const store = this.options.sessionPageStore;
          await best(async () => {
            // The issue follow-ups reply to is stored on the entry; it is
            // never derived from the session id (an operator template).
            const entry = await store.getOrCreate(sessionId, { owner: gh.owner, repo: gh.repo, issueNumber: gh.issueNumber });
            pageUrl = `${this.options.publicBaseUrl!.replace(/\/+$/, "")}/sessions/${entry.token}`;
          });
        }
        const ack = [gh.ack, pageUrl ? `Follow along or send follow-ups: ${pageUrl}` : undefined].filter(Boolean).join("\n\n");
        if (ack) await best(() => this.options.githubReplyClient.postIssueComment(gh.owner, gh.repo, gh.issueNumber, ack));
      }

      const turnLabel = `${envelope.source} event ${envelope.id} → ${trigger.name || "trigger"}`;
      let tracked = await this.trackTurn(sessionId, turnLabel);
      const hooks = gh ? this.remoteControlHooks(gh) : {};
      let outcome = await this.options.orchestratorClient.poll(invocationId, hooks);

      // Unauthenticated turn: `result` is a "link your account" prompt, not
      // finished work. It is posted whenever there is an issue to post to --
      // regardless of `reply.github.result`, since it's an action a human has
      // to take, and nobody would otherwise see it. Then, for a provider whose
      // token store this gateway owns, wait for the link and re-submit the same
      // event (the ack is not repeated).
      if (outcome.status === "succeeded" && outcome.identityLinkPending && outcome.identityLink) {
        await this.completeTurn(sessionId, tracked, outcome);
        if (gh) await best(() => this.options.githubReplyClient.postIssueComment(gh.owner, gh.repo, gh.issueNumber, outcome.result ?? ""));
        const resumed = await this.waitAndResume(outcome.identityLink, async () => {
          const again = await this.options.orchestratorClient.submitEvent(envelope, senderLogin);
          if (again.kind !== "accepted") {
            return { status: "failed", error: `re-submitting the event after linking: ${again.kind === "ignored" ? "no trigger matched" : again.error}` };
          }
          return this.options.orchestratorClient.poll(again.id, hooks);
        });
        if (!resumed) {
          if (http) {
            httpSent = true;
            await best(() => this.postHttpReply(http, trigger, { status: "failed", error: "identity link was not completed; the run did not start" }));
          }
          return;
        }
        tracked = await this.trackTurn(sessionId, turnLabel);
        outcome = resumed;
      }

      await this.completeTurn(sessionId, tracked, outcome);
      if (gh?.result) {
        const text = outcome.status === "succeeded" ? (outcome.result ?? "") : `Something went wrong processing this: ${outcome.error ?? "unknown error"}`;
        await best(() => this.options.githubReplyClient.postIssueComment(gh.owner, gh.repo, gh.issueNumber, text));
      }
      if (http) {
        httpSent = true;
        await best(() => this.postHttpReply(http, trigger, outcome));
      }
    } catch (error) {
      // Last line of defence: the run must not end in silence where the
      // trigger declared somewhere to report to.
      const message = error instanceof Error ? error.message : String(error);
      if (gh?.result) {
        await best(() => this.options.githubReplyClient.postIssueComment(gh.owner, gh.repo, gh.issueNumber, `Something went wrong processing this: ${message}`));
      }
      if (http && !httpSent) await best(() => this.postHttpReply(http, trigger, { status: "failed", error: message }));
      this.report(error);
    } finally {
      // Every outcome: a failed run is exactly when someone wants to
      // re-trigger. Removal is retried internally (github-client.ts) and
      // backstopped by the reconciler; a failure here is reported but never
      // masks the run's own outcome.
      if (gh && label) {
        try {
          await this.options.githubReplyClient.removeIssueLabel(gh.owner, gh.repo, gh.issueNumber, label);
          // Removed for real -- drop the owed-removal record. Best effort: a
          // stale record only costs one idempotent 404 on the next sweep.
          await best(async () => this.options.pendingLabelStore?.clear(sessionId, label));
        } catch (error) {
          // Retries exhausted; the record stays so the reconciler finishes it.
          this.report(error);
        }
      }
    }
  }

  /** Posts the Remote Control link (at most once) to the trigger's issue when the delegated agent surfaces one. */
  private remoteControlHooks(gh: GithubReplyTarget): PollHooks {
    let posted = false;
    return {
      onRemoteControlUrl: async (url) => {
        if (posted) return;
        posted = true;
        try {
          await this.options.githubReplyClient.postIssueComment(gh.owner, gh.repo, gh.issueNumber, `🤖 Watch live or take over the session here: ${url}`);
        } catch (error) {
          this.report(error);
        }
      },
    };
  }

  /**
   * `reply.http`: POST the outcome to the trigger's LITERAL url (it comes only
   * from the EventTrigger CR -- never from event content, so an event can't
   * aim the gateway at an internal address). Body:
   * `{trigger, sessionId, status: "succeeded"|"failed", result?|error?}`;
   * with `secretRef`, `x-event-signature: sha256=<hex hmac(secret, body)>`
   * over the exact bytes sent. A signing secret that can't be read means the
   * reply is NOT sent -- an unsigned callback to a receiver expecting a
   * signature would just be rejected, or worse, accepted by a lax one.
   * Redirects are not followed.
   */
  private async postHttpReply(
    http: NonNullable<RenderedReply["http"]>,
    trigger: AcceptedTrigger,
    outcome: Pick<OrchestratorInvokeResult, "status" | "result" | "error">,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(http.url);
    } catch {
      this.log(`trigger ${trigger.name}: reply.http not sent (invalid url)`);
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      this.log(`trigger ${trigger.name}: reply.http not sent (unsupported scheme ${url.protocol})`);
      return;
    }
    const succeeded = outcome.status === "succeeded";
    const body = JSON.stringify({
      trigger: trigger.name,
      sessionId: trigger.sessionId,
      status: succeeded ? "succeeded" : "failed",
      ...(succeeded ? { result: outcome.result ?? "" } : { error: outcome.error ?? "unknown error" }),
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (http.secretRef) {
      const secret = await this.readSecret(http.secretRef.name, http.secretRef.key);
      if (!secret) {
        this.log(`trigger ${trigger.name}: reply.http not sent (signing secret ${http.secretRef.name}/${http.secretRef.key} unavailable)`);
        return;
      }
      headers[EVENT_SIGNATURE_HEADER] = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
    }
    const doFetch = this.options.replyFetch ?? fetch;
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_REPLY_TIMEOUT_MS),
    });
    if (!res.ok) this.log(`trigger ${trigger.name}: reply.http answered ${res.status}`);
  }

  private async trackTurn(sessionId: string, request: string): Promise<{ turnIndex: number } | undefined> {
    try {
      return await this.options.sessionPageStore?.addTurn(sessionId, request);
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private async completeTurn(
    sessionId: string,
    tracked: { turnIndex: number } | undefined,
    outcome: OrchestratorInvokeResult,
  ): Promise<void> {
    if (!tracked || !this.options.sessionPageStore) return;
    try {
      await this.options.sessionPageStore.completeTurn(
        sessionId,
        tracked.turnIndex,
        outcome.status === "succeeded"
          ? { status: "succeeded", result: outcome.result ?? "" }
          : { status: "failed", error: outcome.error ?? "unknown error" },
      );
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * Default for {@link GatewayServerOptions.resumeWaitMs}: how long to hold a
   * parked turn open waiting for the user to finish linking their account
   * before giving up (they can always re-trigger later). Matches the link
   * flow's own ~10-minute expiry.
   *
   * Was a hard-coded constant, and being unconfigurable had a cost worth
   * recording: every parked turn holds a relay for this whole window. The e2e
   * suite's identity-keying negative controls park deliberately, so a 10-minute
   * hold outlived the spec that caused it and starved the next spec's trigger --
   * surfacing as a positive keying assertion timing out with no orchestrator
   * activity at all, which reads exactly like a keying bug.
   */
  private static readonly DEFAULT_RESUME_WAIT_MS = 10 * 60 * 1000;

  /**
   * A follow-up prompt from the session page: an ordinary conversational turn
   * on the SAME session id (no event), whose result is posted to the issue
   * stored on the page entry.
   */
  private async runSessionTurn(owner: string, repo: string, issueNumber: number, sessionId: string, request: string): Promise<void> {
    // This relay has no browser -- always force device flow explicitly rather
    // than relying on agent-orchestrator's own default ("authcode", intended
    // for browser-based callers).
    const invokeOnce = (): Promise<OrchestratorInvokeResult> =>
      this.options.orchestratorClient.invoke(request, sessionId, "device");

    const finishTurn = async (tracked: { turnIndex: number } | undefined, outcome: OrchestratorInvokeResult): Promise<void> => {
      await this.completeTurn(sessionId, tracked, outcome);
      const reply =
        outcome.status === "succeeded"
          ? (outcome.result ?? "")
          : `Something went wrong processing this: ${outcome.error ?? "unknown error"}`;
      await this.options.githubReplyClient.postIssueComment(owner, repo, issueNumber, reply);
    };

    const tracked = await this.trackTurn(sessionId, request);
    const outcome = await invokeOnce();

    // Unauthenticated turn: post the link prompt, then -- for a provider whose
    // token store this gateway owns -- wait for the link and resume the SAME
    // request automatically.
    if (outcome.status === "succeeded" && outcome.identityLinkPending && outcome.identityLink) {
      await finishTurn(tracked, outcome);
      const resumed = await this.waitAndResume(outcome.identityLink, invokeOnce);
      if (resumed) await finishTurn(await this.trackTurn(sessionId, request), resumed);
      return;
    }

    await finishTurn(tracked, outcome);
  }

  /**
   * Waits for a pending identity link to complete, then re-runs the turn.
   * Only providers whose token store this gateway itself owns can be waited
   * on -- today, both `claude` (setup-token) and `claude-remote` (full
   * login, docs/adr/0027's follow-up), since both live in the same
   * `claudeAuthStore` (`ClaudeTokenStore`, keyed by `kind`). Anything else
   * returns `undefined` and the caller leaves the link prompt standing for a
   * manual re-trigger. Returns the resumed turn's outcome, or `undefined` if
   * the link never landed within the wait window.
   */
  private async waitAndResume(
    identityLink: { provider: string; subject: string },
    reinvoke: () => Promise<OrchestratorInvokeResult>,
  ): Promise<OrchestratorInvokeResult | undefined> {
    const kind = identityLink.provider === "claude" ? "setup-token" : identityLink.provider === "claude-remote" ? "login" : undefined;
    const store = kind ? this.options.claudeAuthStore : undefined;
    if (!store || !kind) return undefined;
    const record = await store.waitForCompletion(
      identityLink.subject,
      this.options.resumeWaitMs ?? GatewayServer.DEFAULT_RESUME_WAIT_MS,
      kind,
    );
    if (!record) return undefined;
    return reinvoke();
  }

  private async handleSessionPage(res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry) {
      res.writeHead(404).end("Not found");
      return;
    }
    // Real-time liveness check (ADR 0026) -- refreshed on every page load
    // rather than trusted from a stale cache, since the underlying Pod could
    // have exited since the last check.
    const liveStatus = await this.options.orchestratorClient.checkLive(entry.sessionId);
    if (liveStatus.live && liveStatus.agentRunId) {
      if (entry.live?.agentRunId !== liveStatus.agentRunId) {
        await this.options.sessionPageStore!.setLive(entry.sessionId, { agentRunId: liveStatus.agentRunId });
        entry.live = { agentRunId: liveStatus.agentRunId };
      }
    } else if (entry.live) {
      await this.options.sessionPageStore!.setLive(entry.sessionId, undefined);
      entry.live = undefined;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderSessionPage(entry, { live: liveStatus.live }));
  }

  /**
   * `GET /sessions/:token/live-events` (ADR 0026): proxies
   * agent-orchestrator's `GET /agent-runs/:runId/events` SSE stream straight
   * through to the browser's `EventSource` -- piped, not buffered.
   */
  private async handleSessionLiveEvents(res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry?.live?.agentRunId) {
      res.writeHead(404).end("Not found");
      return;
    }
    const upstream = await this.options.orchestratorClient.openEventStream(entry.live.agentRunId, entry.sessionId);
    if (!upstream.ok || !upstream.body) {
      res.writeHead(502).end("Live session unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders?.();
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // Client disconnected or upstream dropped -- nothing to recover.
    } finally {
      res.end();
    }
  }

  /**
   * `POST /sessions/:token/live-prompt` (ADR 0026): submits a prompt
   * directly into the live opencode session (fire-and-forget via
   * `prompt_async` -- the response streams back through the SSE view the
   * caller is presumably already watching), discovering and caching the
   * underlying opencode session id on first use.
   */
  private async handleSessionLivePrompt(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry?.live?.agentRunId) {
      res.writeHead(404).end("Not found");
      return;
    }
    const rawBody = await readBody(req);
    const prompt = new URLSearchParams(rawBody).get("prompt")?.trim() ?? "";
    if (prompt) {
      this.submitLivePrompt(entry.sessionId, entry.live.agentRunId, entry.live.opencodeSessionId, prompt).catch(this.report);
    }
    res.writeHead(303, { location: `/sessions/${token}` }).end();
  }

  private async submitLivePrompt(
    sessionId: string,
    agentRunId: string,
    opencodeSessionId: string | undefined,
    prompt: string,
  ): Promise<void> {
    let sessionIdToUse = opencodeSessionId;
    if (!sessionIdToUse) {
      const listed = await this.options.orchestratorClient.forwardOpencode(agentRunId, sessionId, {
        method: "GET",
        path: "/session",
      });
      const sessions = Array.isArray(listed.body) ? (listed.body as Array<{ id?: unknown }>) : [];
      const discovered = sessions.find((s) => typeof s.id === "string")?.id as string | undefined;
      if (!discovered) throw new Error("could not discover the live opencode session id");
      sessionIdToUse = discovered;
      await this.options.sessionPageStore!.setLive(sessionId, { agentRunId, opencodeSessionId: discovered });
    }
    await this.options.orchestratorClient.forwardOpencode(agentRunId, sessionId, {
      method: "POST",
      path: `/session/${sessionIdToUse}/prompt_async`,
      body: { parts: [{ type: "text", text: prompt }] },
    });
  }

  private async handleSessionPrompt(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const entry = await this.options.sessionPageStore!.getByToken(token);
    if (!entry) {
      res.writeHead(404).end("Not found");
      return;
    }
    const rawBody = await readBody(req);
    const prompt = new URLSearchParams(rawBody).get("prompt")?.trim() ?? "";
    if (prompt) {
      this.runSessionTurn(entry.owner, entry.repo, entry.issueNumber, entry.sessionId, prompt).catch(this.report);
    }
    // Redirect back to the page immediately -- the new turn shows as
    // "pending" there (meta-refreshing) rather than blocking this response
    // on the orchestrator's full turn, same async posture as the event path.
    res.writeHead(303, { location: `/sessions/${token}` }).end();
  }
}

/** Buffers a request body, rejecting with {@link BodyTooLargeError} past `limit` bytes. */
function readBodyBuffer(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new BodyTooLargeError(`request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return readBodyBuffer(req, MAX_WEBHOOK_BODY_BYTES).then((b) => b.toString("utf8"));
}
