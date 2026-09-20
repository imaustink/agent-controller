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
  /**
   * The human site URL, e.g. `https://acme.atlassian.net/wiki`. Fixed and
   * trusted; never derived from input.
   *
   * Used for CITATION urls only, not for API calls. The two are genuinely
   * different hosts under OAuth (see `apiBaseFor`), and conflating them would
   * produce citations pointing at `api.atlassian.com` that nobody can open —
   * a link the caller cannot follow is a broken citation, which for a knowledge
   * base is close to no citation at all.
   */
  siteBaseUrl: string;
  fetch?: FetchLike;
  /** Page size for listing; Confluence caps this well below most defaults. */
  pageSize?: number;
  /**
   * Override the OAuth gateway origin. Exists for tests; production never sets
   * it.
   */
  gatewayOrigin?: string;
  /**
   * The site's cloudId, when it is known.
   *
   * Worth setting for a site on a CUSTOM DOMAIN. Discovery matches the site URL
   * reported by `/oauth/token/accessible-resources`, which is the canonical
   * `*.atlassian.net` address — so a connection configured with
   * `https://wiki.example.com` may not match anything, and the check meant to
   * prevent cross-tenant reads would instead reject the only tenant there is.
   * Setting it explicitly removes the guesswork.
   */
  cloudId?: string;
}

/** One entry from `/oauth/token/accessible-resources`. */
interface AccessibleResource {
  id: string;
  url: string;
}

interface ConfluencePage {
  id: string;
  title: string;
  version?: { number?: number; when?: string };
  _links?: { webui?: string; base?: string };
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

  private readonly siteBaseUrl: string;
  private readonly http: FetchLike;
  private readonly pageSize: number;
  private readonly gatewayOrigin: string;
  /**
   * cloudId is a property of the SITE, identical for every caller, so it is
   * resolved once and reused rather than re-fetched per request. Caching it per
   * token would mean an extra round trip for every user on every turn.
   */
  private cloudId: string | undefined;

  constructor(options: ConfluenceDriverOptions) {
    this.siteBaseUrl = options.siteBaseUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.pageSize = options.pageSize ?? 50;
    this.gatewayOrigin = (options.gatewayOrigin ?? "https://api.atlassian.com").replace(/\/+$/, "");
    this.cloudId = options.cloudId;
  }

  /**
   * Where API requests actually go.
   *
   * An Atlassian 3LO token does NOT authenticate against the site host: it is
   * accepted only at the `api.atlassian.com` gateway, addressed by the site's
   * `cloudId`. Calling `https://acme.atlassian.net/wiki/rest/api/...` with a
   * Bearer token returns 401 however valid the token is, which is a failure
   * mode no fetch-mocked test can surface — the mock answers whatever URL it is
   * given.
   */
  private async apiBaseFor(token: string): Promise<string> {
    if (!this.cloudId) this.cloudId = await this.resolveCloudId(token);
    return `${this.gatewayOrigin}/ex/confluence/${this.cloudId}`;
  }

  /**
   * Resolves this site's cloudId from the resources the token can reach.
   *
   * Matched against the configured site URL rather than taking the first
   * entry: a token may reach several sites, and silently picking one would
   * read another site's content while every scope check still passed.
   */
  private async resolveCloudId(token: string): Promise<string> {
    const resources = (await this.request(
      `${this.gatewayOrigin}/oauth/token/accessible-resources`,
      token,
    )) as AccessibleResource[];

    const available = resources ?? [];
    const wanted = new URL(this.siteBaseUrl).origin;

    const match = available.find((resource) => {
      try {
        return new URL(resource.url).origin === wanted;
      } catch {
        return false;
      }
    });
    if (match) return match.id;

    // No origin match. Whether that is expected depends on what was configured.
    //
    // A CUSTOM DOMAIN can never match, because accessible-resources reports the
    // canonical *.atlassian.net address. So when a custom domain was configured
    // and the token reaches exactly one site, there is no ambiguity and
    // refusing would block the only tenant there is.
    //
    // A canonical *.atlassian.net URL that does not match is a different story:
    // both sides are canonical, so they should have matched, and a mismatch
    // means the credential is for a DIFFERENT site. Accepting it there would
    // read another tenant's content while every scope check still passed — so
    // that case keeps refusing however few sites are reachable.
    const configuredCanonical = new URL(this.siteBaseUrl).hostname.endsWith(".atlassian.net");
    if (available.length === 1 && !configuredCanonical) return available[0]!.id;

    throw new PermissionDeniedError(
      available.length === 0
        ? `this credential reaches no Atlassian site; the app may not be installed on ${wanted}`
        : `this credential does not reach ${wanted} (${available.length} site(s) available); ` +
          `if ${wanted} is a custom domain, set the connection's cloudId explicitly`,
    );
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
    const apiBase = await this.apiBaseFor(requireToken(credentials.service));
    const url =
      `${apiBase}/rest/api/content?spaceKey=${encodeURIComponent(scope.space!)}` +
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
    // Delegated when a user is reading; the service credential only during sync.
    const token = requireToken(credentials.delegated ?? credentials.service);
    const apiBase = await this.apiBaseFor(token);
    const page = (await this.request(
      `${apiBase}/rest/api/content/${encodeURIComponent(id)}` +
        `?expand=body.storage,version,space,restrictions.read.restrictions.user,` +
        `restrictions.read.restrictions.group`,
      token,
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
    const apiBase = await this.apiBaseFor(credentials.delegated);
    const page = (await this.request(
      `${apiBase}/rest/api/content/${encodeURIComponent(id)}?expand=version,space`,
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
      // Built from the SITE, never the gateway: a citation the caller cannot
      // open is close to no citation at all. `_links.base` is preferred when
      // the response supplies one, since the source describing itself beats our
      // assumption about where its pages live.
      url: citationUrl(page, this.siteBaseUrl),
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
 * A credential is required for every call; an absent one is a wiring bug rather
 * than an authorization answer, so it fails loudly instead of producing a
 * request with no Authorization header that the source would reject as a 401 —
 * which the error classifier would then read as a permission denial.
 */
function requireToken(token: string | undefined): string {
  if (!token) throw new Error("no credential supplied for a confluence request");
  return token;
}

/**
 * The human URL for a page, for citations.
 *
 * `_links.base` is preferred when present: the source describing where its own
 * pages live beats our assumption about it, and that assumption is exactly the
 * kind of thing that is wrong on first contact with a real tenant.
 */
function citationUrl(page: ConfluencePage, siteBaseUrl: string): string {
  const base = (page._links?.base ?? siteBaseUrl).replace(/\/+$/, "");
  return page._links?.webui ? `${base}${page._links.webui}` : `${base}/pages/${page.id}`;
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
