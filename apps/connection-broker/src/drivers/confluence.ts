import {
  PermissionDeniedError,
  TransientError,
  type Credentials,
  type Cursor,
  type Document,
  type Driver,
  type ListPage,
  type ProbeGranularity,
  type ProbeResult,
  type Scope,
} from "./types.js";

/** Minimal HTTP surface, injectable so the driver is testable without a tenant. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ConfluenceDriverOptions {
  /** Fixed, trusted base URL of the Confluence site. Never derived from input. */
  baseUrl: string;
  fetch?: FetchLike;
  /** Page size for listing; Confluence caps this well below most defaults. */
  pageSize?: number;
}

interface ConfluencePage {
  id: string;
  title: string;
  version?: { number?: number; when?: string };
  _links?: { webui?: string };
  restrictions?: {
    read?: {
      restrictions?: {
        user?: { results?: { accountId?: string }[] };
        group?: { results?: { id?: string; name?: string }[] };
      };
    };
  };
  body?: { storage?: { value?: string } };
}

/**
 * Confluence driver (docs/adr/0038).
 *
 * Scope is a space key, and every request this driver builds is constrained to
 * it — a page id is only ever dereferenced after the space has been asserted,
 * so a planner cannot reach a page in another client's space by supplying its
 * id.
 */
export class ConfluenceDriver implements Driver {
  readonly provider = "confluence";

  private readonly baseUrl: string;
  private readonly http: FetchLike;
  private readonly pageSize: number;

  constructor(options: ConfluenceDriverOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.pageSize = options.pageSize ?? 50;
  }

  validateScope(scope: Scope): void {
    if (!scope.space) throw new Error("a confluence connection must be scoped to a space");
    if (scope.channel || scope.folderID) {
      throw new Error("a confluence connection must set scope.space and nothing else");
    }
    // A space key reaches a URL path, so it is constrained rather than trusted.
    if (!/^[A-Za-z0-9._~-]+$/.test(scope.space)) {
      throw new Error(`illegal confluence space key: ${scope.space}`);
    }
  }

  probeGranularity(): ProbeGranularity {
    return "resource";
  }

  async list(scope: Scope, credentials: Credentials, since: Cursor): Promise<ListPage> {
    this.validateScope(scope);
    const start = Number(since ?? "0");
    const url =
      `${this.baseUrl}/rest/api/content?spaceKey=${encodeURIComponent(scope.space!)}` +
      `&expand=version,restrictions.read.restrictions.user,restrictions.read.restrictions.group` +
      `&limit=${this.pageSize}&start=${start}`;

    const body = (await this.request(url, credentials.service)) as {
      results?: ConfluencePage[];
      size?: number;
    };
    const results = body.results ?? [];

    return {
      resources: results.map((page) => this.toRef(page)),
      // Confluence paginates by offset; an empty page ends the walk.
      cursor: results.length < this.pageSize ? undefined : String(start + results.length),
    };
  }

  async fetch(scope: Scope, credentials: Credentials, id: string): Promise<Document> {
    this.validateScope(scope);
    const page = (await this.request(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(id)}` +
        `?expand=body.storage,version,space,restrictions.read.restrictions.user,` +
        `restrictions.read.restrictions.group`,
      // Delegated when a user is reading; the service credential only during sync.
      credentials.delegated ?? credentials.service,
    )) as ConfluencePage & { space?: { key?: string } };

    assertInScope(page, scope, id);

    return {
      ...this.toRef(page),
      markdown: storageToMarkdown(page.body?.storage?.value ?? ""),
    };
  }

  async probe(scope: Scope, credentials: Credentials, id?: string): Promise<ProbeResult> {
    this.validateScope(scope);
    if (!id) throw new Error("confluence probes are per resource and need a page id");
    if (!credentials.delegated) {
      // Probing with the service credential would answer a different question
      // than the one being asked, and answer it permissively.
      throw new Error("a confluence probe requires the calling user's delegated token");
    }

    // Deliberately minimal: the probe establishes readability and returns the
    // fields a citation needs. The body is the model's to request separately
    // (docs/adr/0040), so it is not pulled here.
    const page = (await this.request(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(id)}?expand=version,space`,
      credentials.delegated,
    )) as ConfluencePage & { space?: { key?: string } };

    assertInScope(page, scope, id);

    const ref = this.toRef(page);
    return { allowed: true, title: ref.title, url: ref.url, version: ref.version };
  }

  private toRef(page: ConfluencePage) {
    const users = page.restrictions?.read?.restrictions?.user?.results ?? [];
    const groups = page.restrictions?.read?.restrictions?.group?.results ?? [];
    const principals = [
      ...users.map((user) => `user:${user.accountId}`).filter((p) => !p.endsWith("undefined")),
      ...groups.map((group) => `group:${group.id ?? group.name}`).filter((p) => !p.endsWith("undefined")),
    ];

    return {
      id: page.id,
      title: page.title,
      url: page._links?.webui ? `${this.baseUrl}${page._links.webui}` : `${this.baseUrl}/pages/${page.id}`,
      version: page.version?.number === undefined ? undefined : String(page.version.number),
      updatedAt: page.version?.when,
      // No explicit read restrictions means space-level permissions govern,
      // which this driver does not resolve. Marked permissive rather than
      // guessed: the probe is the authority, and under-inclusion is the only
      // direction that hurts (docs/adr/0040).
      acl: principals.length > 0 ? { principals } : { principals: [], permissive: true },
    };
  }

  private async request(url: string, token: string | undefined): Promise<unknown> {
    if (!token) throw new Error("no credential supplied for a confluence request");

    let response;
    try {
      response = await this.http(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (cause) {
      // A network failure is not an answer about permissions.
      throw new TransientError(`confluence request failed: ${String(cause)}`);
    }

    if (response.ok) return response.json();

    // The distinction that must not be blurred (docs/adr/0040): 403/404 is a
    // drop, anything else is "we could not find out".
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new PermissionDeniedError(`confluence returned ${response.status}`);
    }
    throw new TransientError(`confluence returned ${response.status}`);
  }
}

/**
 * Asserts a page belongs to this connection's space.
 *
 * This is the only thing stopping a guessed or leaked page id from reaching
 * another client's space, so it fails CLOSED: the space key must be present AND
 * equal. An earlier version read `page.space?.key && page.space.key !== scope.space`,
 * which short-circuits to falsy when the field is absent and serves the page —
 * the one direction this check must never fail in.
 *
 * Every call site requests `expand=…,space`, so a response without it is a
 * provider contract we no longer recognise, and continuing on a boundary check
 * we could not evaluate is exactly the wrong response to that.
 */
function assertInScope(
  page: { space?: { key?: string } },
  scope: Scope,
  id: string,
): void {
  if (page.space?.key === scope.space) return;
  throw new PermissionDeniedError(
    page.space?.key
      ? `page ${id} is in space ${page.space.key}, outside this connection's scope`
      : `page ${id} came back without a space key; cannot confirm it is inside this connection's scope`,
  );
}

/**
 * Confluence storage format is XHTML. This is a deliberately small conversion —
 * enough structure for chunking to have something to cut on, without taking a
 * parser dependency into a security-sensitive service.
 */
export function storageToMarkdown(storage: string): string {
  return storage
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_m, level: string, text: string) =>
      `\n${"#".repeat(Number(level))} ${stripTags(text)}\n`,
    )
    .replace(/<li[^>]*>(.*?)<\/li>/gis, (_m, text: string) => `- ${stripTags(text)}\n`)
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, "").trim();
