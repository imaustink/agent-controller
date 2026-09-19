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
   * MUST throw `PermissionDeniedError` or `TransientError` rather than a bare
   * Error: the caller cannot tell which an unclassified failure meant, and
   * guessing is how a leak gets introduced.
   */
  probe(scope: Scope, credentials: Credentials, id?: string): Promise<ProbeResult>;
}
