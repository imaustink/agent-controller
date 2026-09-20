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
   * The human site URL, e.g. `https://wiki.example.com/wiki`. Fixed and
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

/**
 * A page as the v2 API returns it.
 *
 * Note what is NOT here: read restrictions. v1 could expand them onto a content
 * response; v2 cannot, and its own `/restrictions` endpoint refuses the scopes
 * this driver holds. They come from a separate call (`readRestrictions`).
 */
interface ConfluencePage {
  id: string;
  title: string;
  /** v2 identifies the space by ID. There is no nested `space.key`. */
  spaceId?: string | number;
  version?: { number?: number; createdAt?: string };
  _links?: { webui?: string; base?: string };
  body?: { storage?: { value?: string } };
}

/** The v1 read-restriction response, which is still the only one that answers. */
interface ReadRestrictions {
  restrictions?: {
    user?: { results?: { accountId?: string }[] };
    group?: { results?: { id?: string; name?: string }[] };
  };
}

/** Read restrictions as this driver passes them around, before becoming an ACL. */
type Principals = string[];

/**
 * Confluence driver (docs/adr/0038).
 *
 * Speaks the v2 REST API. Not a preference: the v1 content endpoints now return
 * `410 Gone — This deprecated endpoint has been removed`, so the generation this
 * driver was first written against no longer exists. v1 survives for read
 * restrictions alone, which is why this file straddles both.
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
  /**
   * Space KEY to space ID, cached for the same reason as cloudId: it is a
   * property of the site, not of the caller. Keyed by space key because one
   * driver instance serves one connection today but need not forever.
   */
  private readonly spaceIds = new Map<string, string>();

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
   * `cloudId`. Calling `https://acme.atlassian.net/wiki/api/v2/...` with a
   * Bearer token returns 401 however valid the token is, which is a failure
   * mode no fetch-mocked test can surface — the mock answers whatever URL it is
   * given.
   *
   * The `/wiki` context path is kept: Confluence sits under it at the gateway
   * just as it does on the site.
   */
  private async apiBaseFor(token: string): Promise<string> {
    if (!this.cloudId) this.cloudId = await this.resolveCloudId(token);
    return `${this.gatewayOrigin}/ex/confluence/${this.cloudId}/wiki`;
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

  /**
   * Resolves a space KEY to the space ID that v2 addresses pages by.
   *
   * The Connection is written in terms of the key, because that is what a human
   * knows the space by and what survives being read back in a review. v2 takes
   * only the id, so exactly one translation happens here rather than leaking
   * ids into configuration.
   */
  private async spaceIdFor(spaceKey: string, token: string): Promise<string> {
    const cached = this.spaceIds.get(spaceKey);
    if (cached) return cached;

    const apiBase = await this.apiBaseFor(token);
    const body = (await this.request(
      `${apiBase}/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`,
      token,
    )) as { results?: { id?: string | number; key?: string }[] };

    // Matched on the key rather than trusting position: a filter that silently
    // returned something else would scope every later check to the wrong space.
    const space = (body.results ?? []).find((candidate) => candidate.key === spaceKey);
    if (space?.id === undefined) {
      throw new PermissionDeniedError(
        `space ${spaceKey} is not visible to this credential, so its pages cannot be scoped`,
      );
    }

    const id = String(space.id);
    this.spaceIds.set(spaceKey, id);
    return id;
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
    const token = requireToken(credentials.service);
    const apiBase = await this.apiBaseFor(token);
    const spaceId = await this.spaceIdFor(scope.space!, token);

    // v2 paginates by opaque cursor, not offset. The cursor is carried through
    // `Cursor` untouched — reconstructing one would couple us to its encoding,
    // which Atlassian does not promise to keep.
    const url =
      `${apiBase}/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&limit=${this.pageSize}` +
      (since ? `&cursor=${encodeURIComponent(since)}` : "");

    const body = (await this.request(url, token)) as {
      results?: ConfluencePage[];
      _links?: { next?: string };
    };
    const results = body.results ?? [];

    // One extra request per page, because v2 dropped inline restriction
    // expansion and its replacement refuses this driver's scopes. That cost is
    // paid here, during sync, and never on the retrieval path — the probe is
    // the authorization decision and does not consult the mirror at all
    // (docs/adr/0040).
    const resources = await Promise.all(
      results.map(async (page) => this.toRef(page, await this.readRestrictions(apiBase, token, page.id))),
    );

    return { resources, cursor: nextCursor(body._links?.next) };
  }

  async fetch(scope: Scope, credentials: Credentials, id: string): Promise<Document> {
    this.validateScope(scope);
    // Delegated when a user is reading; the service credential only during sync.
    const token = requireToken(credentials.delegated ?? credentials.service);
    const apiBase = await this.apiBaseFor(token);
    const page = (await this.request(
      `${apiBase}/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`,
      token,
    )) as ConfluencePage;

    await this.assertInScope(page, scope, id, token);

    return {
      ...this.toRef(page, await this.readRestrictions(apiBase, token, id)),
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
    // (docs/adr/0040), so no body-format is asked for, and no restrictions are
    // read — this call reaching 200 under the USER's token is the authorization
    // decision, which is a stronger statement than any mirrored ACL.
    const apiBase = await this.apiBaseFor(credentials.delegated);
    const page = (await this.request(
      `${apiBase}/api/v2/pages/${encodeURIComponent(id)}`,
      credentials.delegated,
    )) as ConfluencePage;

    await this.assertInScope(page, scope, id, credentials.delegated);

    const ref = this.toRef(page, []);
    return { allowed: true, title: ref.title, url: ref.url, version: ref.version };
  }

  /**
   * Reads a page's read restrictions for the ACL mirror.
   *
   * Uses the v1 endpoint deliberately. v2's `/pages/{id}/restrictions` returns
   * `401 scope does not match` under the granular read scopes this driver
   * holds, while the v1 path answers — an asymmetry worth naming, because the
   * obvious cleanup of "move everything to v2" silently breaks the mirror.
   *
   * A failure here degrades to permissive rather than propagating: the mirror
   * is a pre-filter, never the authorization decision, so a missing entry costs
   * a wasted probe while a wrongly restrictive one hides a page the caller can
   * actually read.
   */
  private async readRestrictions(apiBase: string, token: string, id: string): Promise<Principals> {
    let body: ReadRestrictions;
    try {
      body = (await this.request(
        `${apiBase}/rest/api/content/${encodeURIComponent(id)}/restriction/byOperation/read`,
        token,
      )) as ReadRestrictions;
    } catch {
      return [];
    }

    const users = body.restrictions?.user?.results ?? [];
    const groups = body.restrictions?.group?.results ?? [];
    return [
      ...users.map((user) => user.accountId).filter(isPresent).map((id) => `user:${id}`),
      ...groups.map((group) => group.id ?? group.name).filter(isPresent).map((id) => `group:${id}`),
    ];
  }

  private toRef(page: ConfluencePage, principals: Principals) {
    return {
      id: page.id,
      title: page.title,
      // Built from the configured SITE rather than `_links.base`. The source
      // describing itself would normally win, but on a custom domain it reports
      // the canonical *.atlassian.net address — correct, resolvable, and not
      // the domain anyone in the org recognises or may even be able to reach.
      url: citationUrl(page, this.siteBaseUrl),
      version: page.version?.number === undefined ? undefined : String(page.version.number),
      updatedAt: page.version?.createdAt,
      // No explicit read restrictions means space-level permissions govern,
      // which this driver does not resolve. Marked permissive rather than
      // guessed: the probe is the authority, and under-inclusion is the only
      // direction that hurts (docs/adr/0040).
      acl: principals.length > 0 ? { principals } : { principals: [], permissive: true },
    };
  }

  /**
   * Asserts a page belongs to this connection's space.
   *
   * This is the only thing stopping a guessed or leaked page id from reaching
   * another client's space, so it fails CLOSED: `spaceId` must be present AND
   * equal to the configured space's id.
   *
   * Compared as strings because the two sides arrive from different endpoints
   * and v2 is not consistent about quoting ids — `1952415750 !== "1952415750"`
   * would fail closed rather than open, but it would fail on every page.
   */
  private async assertInScope(
    page: ConfluencePage,
    scope: Scope,
    id: string,
    token: string,
  ): Promise<void> {
    const expected = await this.spaceIdFor(scope.space!, token);
    if (page.spaceId !== undefined && String(page.spaceId) === expected) return;

    throw new PermissionDeniedError(
      page.spaceId === undefined
        ? `page ${id} came back without a space id; cannot confirm it is inside this connection's scope`
        : `page ${id} is in space ${String(page.spaceId)}, outside this connection's scope`,
    );
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

const isPresent = (value: string | undefined): value is string => value !== undefined;

/**
 * Pulls the opaque cursor out of the `next` link v2 returns.
 *
 * The link is a path rather than an absolute URL, so it is parsed against a
 * throwaway origin. Absent means the walk is finished — the only reliable end
 * signal, since a short page is not one (v2 may return fewer results than the
 * limit and still have more).
 */
function nextCursor(next: string | undefined): Cursor {
  if (!next) return undefined;
  try {
    return new URL(next, "https://example.invalid").searchParams.get("cursor") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The human URL for a page, for citations.
 *
 * `_links.webui` is a site-relative path (`/spaces/SNC/pages/123/Title`), so it
 * is appended to the configured site base — which already carries `/wiki`.
 */
function citationUrl(page: ConfluencePage, siteBaseUrl: string): string {
  const base = siteBaseUrl.replace(/\/+$/, "");
  return page._links?.webui ? `${base}${page._links.webui}` : `${base}/pages/${page.id}`;
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
