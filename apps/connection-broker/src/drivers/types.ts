/**
 * The provider driver contract (docs/adr/0038 §1, extended by 0040).
 *
 * This is the generalization the whole design rests on. Confluence, Slack and
 * Drive differ in perhaps 150 lines each; pagination, incremental diffing,
 * chunking, embedding, RBAC, webhook plumbing, retries and status reporting are
 * written once around this interface. Adding Jira or Notion later is an
 * implementation of it, not a new service.
 */

/** The bounded set of resources a Connection reaches. Exactly one field is set. */
export interface Scope {
  space?: string;
  channel?: string;
  folderID?: string;
}

/**
 * An opaque per-driver cursor. A Slack `ts`, a Confluence version marker, a
 * Drive changes token — nothing above the driver interprets it, which is what
 * lets each provider express "changed since" in its own terms.
 */
export type Cursor = string | undefined;

/** One resource the driver knows about, before its body is fetched. */
export interface ResourceRef {
  id: string;
  title: string;
  url: string;
  /** Provider-defined version; compared against an indexed chunk's to detect staleness. */
  version?: string;
  updatedAt?: string;
  /**
   * The principals the mirror should pre-filter on — group ids, account ids,
   * whatever the provider uses (docs/adr/0040).
   *
   * **Tuned to over-include.** Where effective permissions cannot be confidently
   * resolved, a driver returns `permissive: true` rather than guessing a
   * restrictive set. Over-inclusion costs one wasted probe; under-inclusion
   * silently suppresses results the user was entitled to see, and is the only
   * direction that causes user-visible harm.
   */
  acl?: { principals: string[]; permissive?: boolean };
}

/** A resource with its body, normalized to Markdown. */
export interface Document extends ResourceRef {
  markdown: string;
}

export interface ListPage {
  resources: ResourceRef[];
  cursor: Cursor;
}

/**
 * The unit a provider authorizes at (docs/adr/0040).
 *
 * Confluence and Drive authorize a page or a file. Slack authorizes a CHANNEL —
 * membership is the access unit, and there is no per-message permission to
 * check — so one probe settles every candidate from that connection, which is
 * cheaper than the per-resource case rather than harder.
 */
export type ProbeGranularity = "resource" | "connection";

export interface ProbeResult {
  allowed: boolean;
  title: string;
  url: string;
  version?: string;
}

/** The source says this user may not read it. Drop the candidate. */
export class PermissionDeniedError extends Error {
  readonly name = "PermissionDeniedError";
}

/**
 * We could not find out — a 429, a 5xx, a timeout.
 *
 * Deliberately NOT a denial. Treating it as one silently shrinks an answer in a
 * way nobody can see, and makes the same question return different evidence
 * depending on whether the source was busy.
 */
export class TransientError extends Error {
  readonly name = "TransientError";
}

/**
 * The source will never answer this call, however many times we ask.
 *
 * Distinct from `TransientError` for one reason: a transient failure is retried
 * and a permanent one must not be. Confluence's v1 content endpoints now return
 * `410 Gone`, and classifying that as transient means a sync loop that retries
 * a removed endpoint forever, reporting "temporarily unavailable" about
 * something that is never coming back.
 *
 * It is not a denial either — the caller is not being refused, the call no
 * longer exists — so it must not be swallowed the way a drop is. It should
 * reach an operator.
 */
export class PermanentError extends Error {
  readonly name = "PermanentError";
}

/** How a driver is told which credential to act with. */
export interface Credentials {
  /** The connection's shared service credential — ingestion only. */
  service?: string;
  /**
   * The calling user's delegated token. Required for anything a user will see:
   * probes, the GET face, and live fetches (docs/adr/0040).
   */
  delegated?: string;
}

/** A provider's change notification, once verified and understood. */
export interface WebhookEvent {
  /**
   * WHICH subset this delivery is about — a channel id, a space key, a folder
   * id — so the broker can route it to the Corpora that cover it (ADR 0043 §4).
   *
   * Reported rather than filtered against, because one Connection serves many
   * Corpora and a driver no longer knows which subsets exist. Absent means the
   * provider said something changed without saying where, which escalates to a
   * full pass rather than to nothing.
   */
  scopeKey?: string;

  /**
   * The resources this notification says changed.
   *
   * EMPTY is meaningful and common: Drive's push notifications name a channel
   * rather than a file, and Slack's events can arrive for things this
   * connection does not index. An empty list means "something changed, we do
   * not know what", which callers turn into a full pass rather than into
   * nothing.
   */
  sourceIds: string[];
}

/** The raw request a provider delivered, before any interpretation. */
export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  /**
   * The body EXACTLY as received.
   *
   * Signatures are computed over the bytes, so a parsed-and-restringified body
   * verifies against nothing. This has to arrive unmodified from the socket.
   */
  rawBody: string;
}

/** A read of the live source, made as the calling user (ADR 0038 §5). */
export interface ApiRequest {
  /**
   * The path the caller asked for, relative to the provider — `pages/12345`,
   * `conversations.info`. Never a full URL: a caller that supplied the host
   * could point this driver at anything the credential can reach.
   */
  path: string;
  /** Query parameters, allowlisted per driver like the path is. */
  query?: Record<string, string>;
}

export interface ApiResponse {
  /** The source's answer, already narrowed to what the allowlist permits. */
  body: unknown;
  /** Where a human can see the same thing, for a citation. */
  url?: string;
}

export interface Driver {
  readonly provider: string;

  /**
   * Rejects a scope this driver cannot honour. Called at admission-time on the
   * CRD too, but re-checked here: scope is the security boundary, and a driver
   * that accepts an unvalidated one silently widens a client boundary.
   */
  validateScope(scope: Scope): void;

  /** Incremental listing, service-credentialled. Ingestion deliberately ignores permissions. */
  list(scope: Scope, credentials: Credentials, since: Cursor): Promise<ListPage>;

  /** One resource, normalized. Service-credentialled during sync; delegated when a user reads it. */
  fetch(scope: Scope, credentials: Credentials, id: string): Promise<Document>;

  /** Which unit `probe` applies to. */
  probeGranularity(): ProbeGranularity;

  /**
   * Asks the source, as the calling user, whether a resource is readable —
   * returning the title, URL and version a citation must be built from.
   *
   * MUST throw `PermissionDeniedError`, `TransientError` or `PermanentError`
   * rather than a bare Error: the caller cannot tell which an unclassified
   * failure meant, and guessing is how a leak gets introduced.
   */
  probe(scope: Scope, credentials: Credentials, id?: string): Promise<ProbeResult>;

  /**
   * Verifies a provider's change notification and says what it refers to.
   *
   * Optional: a provider without push notifications simply does not implement
   * it, and that connection stays on its reconcile interval — which is the
   * source of truth regardless (ADR 0038 §4). Webhooks only make it faster.
   *
   * This runs on an endpoint reachable WITHOUT a bearer token, because the
   * provider is the caller. The signature is therefore the only thing standing
   * between a stranger and the ability to make this broker spend a client's
   * credential on demand, so an implementation MUST throw rather than return
   * for anything it cannot verify.
   *
   * Returning `undefined` means "verified, but not something to act on" — a
   * Slack URL-verification handshake, a Drive sync ping. Distinct from
   * throwing, which means the request was not trustworthy, and from reporting a
   * scopeKey nothing covers, which is the ordinary case and is the broker's to
   * decide.
   */
  parseWebhook?(request: WebhookRequest, secret: string): WebhookEvent | undefined;

  /**
   * Reads the CURRENT state of one resource, as the calling user.
   *
   * The live face a Corpus exposes when the indexed snapshot is not good
   * enough — the model decides when to spend it (ADR 0040), rather than every
   * retrieval paying for hydration it may not need.
   *
   * Four constraints, and each one is load-bearing:
   *
   *   - GET ONLY. There is no authorization story for a write here and no
   *     appetite to invent one: a tool that can mutate a client's Confluence
   *     is a different risk class from one that can read it.
   *   - The DELEGATED credential, always. This answers "what may this user
   *     see", and answering it with the ingestion credential would answer a
   *     different question, permissively.
   *   - Inside the Corpus's scope. Same boundary `fetch` enforces: a path or
   *     id outside it is refused however it was obtained.
   *   - Path ALLOWLISTED by the driver. A caller-supplied path reaches a URL,
   *     and a provider API is far larger than the part a knowledge base needs.
   *     The allowlist is what stops the GET face becoming a general proxy onto
   *     the credential.
   *
   * Optional: a provider without a useful live read simply does not implement
   * it, and no GET tool is generated for its Corpora.
   */
  api?(scope: Scope, credentials: Credentials, request: ApiRequest): Promise<ApiResponse>;
}
