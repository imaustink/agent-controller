import {
  PermanentError,
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
  type SearchHit,
  type WebhookEvent,
  type WebhookRequest,
} from "./types.js";
import { hmacHex, signaturesMatch } from "./webhook-signature.js";

/** Minimal HTTP surface, injectable so the driver is testable without a tenant. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /**
   * Read for the explanatory text on a FAILED response only. Optional so a test
   * double need not supply one, and never called on success.
   */
  text?: () => Promise<string>;
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
    // An API token addresses the site directly. There is no OAuth gateway in
    // front of it and no cloudId to resolve — `/oauth/token/accessible-resources`
    // is an OAuth endpoint and does not answer for Basic auth at all, so
    // routing this through the gateway would fail before the first real call.
    //
    // The cross-tenant check the gateway path needs is moot here for the same
    // reason it is needed there: a Bearer token may reach several sites and
    // has to be pinned to one, while an API token is issued against exactly
    // the site in `siteBaseUrl` and can reach no other.
    if (isApiToken(token)) return this.siteBaseUrl.replace(/\/+$/, "");

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

    // No origin match, and there is no safe way to guess past it.
    //
    // A CUSTOM DOMAIN can never match here, because accessible-resources
    // reports the canonical *.atlassian.net address. An earlier version treated
    // "custom domain and exactly one reachable site" as unambiguous and used
    // that site. It is not unambiguous: the origin check has already failed, so
    // nothing has confirmed the one reachable site is the configured tenant. A
    // credential provisioned for a DIFFERENT single-tenant org satisfies that
    // branch exactly, and because cloudId is resolved by whichever token calls
    // first and then cached for every caller, one such token would point the
    // whole connection at another org — with every later scope check passing,
    // because they would all be evaluated against that org's space.
    //
    // So a custom domain must name its cloudId. It is one field, the verify
    // script prints it, and the alternative is trusting an unverified tenant.
    throw new PermissionDeniedError(
      available.length === 0
        ? `this credential reaches no Atlassian site; the app may not be installed on ${wanted}`
        : `this credential does not reach ${wanted} (${available.length} site(s) available); ` +
          `if ${wanted} is a custom domain, set the connection's cloudId explicitly — ` +
          `it cannot be inferred, because a custom domain never matches the canonical ` +
          `address this endpoint reports`,
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

  /**
   * Reads any page the CALLER can see (see Driver.readAsUser).
   *
   * No space assertion: Confluence applies this user's own permissions, and a
   * page they cannot read comes back 404 whichever space it is in.
   */
  async readAsUser(credentials: Credentials, id: string): Promise<Document> {
    const token = requireDelegated(credentials, "confluence");
    const apiBase = await this.apiBaseFor(token);

    const page = (await this.request(
      `${apiBase}/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`,
      token,
    )) as ConfluencePage;

    return {
      ...this.toRef(page, []),
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
   * Verifies a Confluence webhook delivery.
   *
   * Atlassian signs the raw body with the secret configured on the webhook and
   * sends it as `X-Hub-Signature: sha256=<hex>`. There is no timestamp to bind,
   * so unlike Slack this cannot rule out replay — which is survivable here
   * precisely because a webhook only ever triggers a PARTIAL pass over pages
   * the source is then re-read for. A replayed notification costs a redundant
   * fetch, not a wrong corpus.
   *
   * It reports which SPACE changed rather than filtering to one: a Connection
   * serves many Corpora and this driver no longer knows which spaces are
   * indexed (ADR 0043 §4).
   */
  parseWebhook(request: WebhookRequest, secret: string): WebhookEvent | undefined {
    const provided = request.headers["x-hub-signature"];
    if (!provided) throw new PermissionDeniedError("confluence webhook carried no signature");

    const expected = `sha256=${hmacHex(secret, request.rawBody)}`;
    if (!signaturesMatch(provided, expected)) {
      throw new PermissionDeniedError("confluence webhook signature did not verify");
    }

    let body: { page?: { id?: number | string; spaceKey?: string }; space?: { spaceKey?: string } };
    try {
      body = JSON.parse(request.rawBody);
    } catch {
      throw new PermissionDeniedError("confluence webhook body was not JSON");
    }

    const pageId = body.page?.id;
    // No page id means "something in this space changed, we do not know what".
    // An empty list is how that is expressed; the caller escalates to a full
    // pass rather than doing nothing.
    return {
      scopeKey: body.page?.spaceKey ?? body.space?.spaceKey,
      sourceIds: pageId === undefined ? [] : [String(pageId)],
    };
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

  /**
   * Live CQL search, as the caller, inside the corpus's space.
   *
   * Every clause here was verified against the live tenant rather than read off
   * the docs (scripts/probe-confluence-search.mjs), which matters because this
   * driver previously shipped against v1 endpoints that had been 410 Gone for
   * months:
   *
   * - `/rest/api/search` is ALIVE. The v1 deprecation took `/rest/api/content`
   *   with it but not this, and v2 has no text search to migrate to.
   * - It needs the `search:confluence` scope, which the sync path never asked
   *   for. Without it the call fails on a token that reads pages perfectly well.
   * - `type = page` is load-bearing. Unconstrained, the top hit on a real space
   *   was a FOLDER, and folders, blogposts and attachments carry ids the read
   *   tool cannot serve — the agent would be handed references that always fail.
   * - The space term does real work: dropping it returned pages from another
   *   client's space on this same tenant.
   */
  async searchAsUser(
    credentials: Credentials,
    scope: Scope,
    query: string,
    limit = 10,
  ): Promise<SearchHit[]> {
    this.validateScope(scope);
    if (!credentials.delegated) {
      throw new Error("a confluence search requires the calling user's delegated token");
    }

    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    // CQL string literals are double-quoted, so a quote or backslash in the
    // user's words would end the literal and let the rest be read as query
    // syntax — against a term the CALLER supplies. Escaped, not stripped: the
    // words are the user's question and mangling them changes the search.
    const escaped = trimmed.replace(/["\\]/g, "\\$&");
    const cql = `space = "${scope.space}" AND type = page AND text ~ "${escaped}"`;

    const apiBase = await this.apiBaseFor(credentials.delegated);
    const url = `${apiBase}/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${Math.min(limit, 25)}`;
    const body = (await this.request(url, credentials.delegated)) as {
      results?: ConfluenceSearchResult[];
    };

    return (body.results ?? [])
      .map((result) => toSearchHit(result, this.siteBaseUrl))
      .filter((hit): hit is SearchHit => hit !== undefined);
  }

  private async request(url: string, token: string | undefined): Promise<unknown> {
    if (!token) throw new Error("no credential supplied for a confluence request");

    let response;
    try {
      response = await this.http(url, {
        headers: { Authorization: authorization(token), Accept: "application/json" },
      });
    } catch (cause) {
      // A network failure is not an answer about permissions.
      throw new TransientError(`confluence request failed: ${String(cause)}`);
    }

    if (response.ok) return response.json();

    // Atlassian explains itself in the error body, and that explanation is
    // worth more than it looks: `scope does not match` and `This deprecated
    // endpoint has been removed` are the same 4xx-shaped failure from the
    // outside and have completely different fixes. Dropping it cost real hours.
    const detail = await describeFailure(response);

    // 410 is permanent. Retrying it is not merely wasted work — it reports
    // "temporarily unavailable" forever about an endpoint that has been
    // withdrawn, which is how a removed API looks like a flaky one.
    if (response.status === 410) {
      throw new PermanentError(`confluence returned 410 Gone${detail}`);
    }

    // The distinction that must not be blurred (docs/adr/0040): 403/404 is a
    // drop, anything else is "we could not find out".
    //
    // 401 is deliberately NOT a drop, though it looks like one. Confluence
    // answers 403/404 for a page this USER may not read; a 401 means the
    // CREDENTIAL was rejected — expired, wrong audience, wrong scope — which
    // says nothing about what the user may see. Treating it as a denial would
    // silently shrink every answer the moment a token went stale, and report it
    // as a routine per-page denial. This PR chased `401 scope does not match`
    // for hours precisely because a systemic failure wore a per-resource face.
    if (response.status === 403 || response.status === 404) {
      throw new PermissionDeniedError(`confluence returned ${response.status}${detail}`);
    }
    throw new TransientError(`confluence returned ${response.status}${detail}`);
  }
}

/**
 * A credential is required for every call; an absent one is a wiring bug rather
 * than an authorization answer, so it fails loudly instead of producing a
 * request with no Authorization header that the source would reject as a 401 —
 * which the error classifier would then read as a permission denial.
 */
/**
 * The delegated credential, for a read bounded by identity rather than scope.
 *
 * Refuses the service credential outright. Falling back to it would turn a
 * "what may this person see" read into a "what may the ingestion account see"
 * one — and that account is scoped to nothing, so the fallback would be the
 * widest possible read at exactly the moment the narrowest was intended.
 */
function requireDelegated(credentials: Credentials, provider: string): string {
  if (!credentials.delegated) {
    throw new Error(`a ${provider} user read requires the calling user's delegated token`);
  }
  return credentials.delegated;
}

function requireToken(token: string | undefined): string {
  if (!token) throw new Error("no credential supplied for a confluence request");
  return token;
}

const isPresent = (value: string | undefined): value is string => value !== undefined;

/**
 * The provider's own explanation of a failure, bounded and safe to log.
 *
 * Truncated because an error body is not always small — an HTML error page from
 * a proxy in front of the API is a realistic response, and pasting one into an
 * exception message helps nobody. Never throws: failing to read why something
 * failed must not replace the failure with a different one.
 */
async function describeFailure(response: { text?: () => Promise<string> }): Promise<string> {
  try {
    const body = (await response.text?.())?.trim();
    return body ? `: ${body.slice(0, 300)}` : "";
  } catch {
    return "";
  }
}

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

  // Read out of the RAW query string rather than through URLSearchParams.
  // `searchParams.get` form-decodes, which turns a literal `+` into a space —
  // and these cursors are base64, whose alphabet includes `+`. `list` re-encodes
  // with encodeURIComponent, so a form-decoded cursor would go back as `%20`
  // and no longer be the token Confluence issued: the walk skips or 400s
  // partway through a space, which is the kind of bug that only appears on
  // corpora large enough to paginate.
  const raw = /[?&]cursor=([^&]*)/.exec(next)?.[1];
  if (raw === undefined || raw === "") return undefined;
  try {
    // Percent-escapes still have to come off; only the `+`-as-space rule is
    // wrong here, and decodeURIComponent does not apply it.
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape is not worth failing a sync over; ending the walk is
    // the conservative read, since reconcile only deletes on a FULL pass.
    return undefined;
  }
}

/** A `/rest/api/search` hit. The page lives under `content`; the rest is search metadata. */
interface ConfluenceSearchResult {
  content?: { id?: string; type?: string; title?: string };
  title?: string;
  excerpt?: string;
  /** Site-relative, like `_links.webui` — `/spaces/BITOVI/pages/997064705/Title`. */
  url?: string;
  lastModified?: string;
}

/**
 * A search hit as a ResourceRef, or undefined for one we cannot cite.
 *
 * A hit with no content id is dropped rather than passed on with a blank id:
 * the id is what the read tool is handed, so an unusable one is a reference
 * that always fails, which is worse for the agent than one fewer result.
 *
 * No `acl` is set. These come from a search run as the USER, so they are
 * already filtered by what that person can see — the mirror's pre-filter
 * exists for the INDEX, where the reader is not the one who fetched.
 */
function toSearchHit(result: ConfluenceSearchResult, siteBaseUrl: string): SearchHit | undefined {
  const id = result.content?.id;
  if (!id) return undefined;

  const base = siteBaseUrl.replace(/\/+$/, "");
  return {
    id,
    title: result.content?.title ?? result.title ?? id,
    url: result.url ? `${base}${result.url}` : `${base}/pages/${id}`,
    updatedAt: result.lastModified,
    // Confluence marks matched terms with @@@hl@@@ sentinels; they are noise
    // to a model, which reads the words rather than the highlighting.
    excerpt: result.excerpt?.replace(/@@@(end)?hl@@@/g, "").trim() || undefined,
  };
}

/**
 * Whether this credential is an Atlassian API token rather than an OAuth
 * access token.
 *
 * The convention is `email:token`, which is exactly what Atlassian's own docs
 * tell you to base64 for Basic auth — so an operator pastes the two halves
 * they already have rather than learning a format of ours.
 *
 * Detected on the separator plus an `@` in the first half. An OAuth access
 * token is a JWT or an opaque string and contains neither, so the two shapes
 * cannot be confused for one another.
 */
export function isApiToken(token: string): boolean {
  const separator = token.indexOf(":");
  return separator > 0 && token.slice(0, separator).includes("@");
}

/** The Authorization header for whichever credential shape this is. */
function authorization(token: string): string {
  if (!isApiToken(token)) return `Bearer ${token}`;
  return `Basic ${Buffer.from(token, "utf8").toString("base64")}`;
}

/**
 * The human URL for a page, for citations.
 *
 * `_links.webui` is a site-relative path (`/spaces/GLOBEX/pages/123/Title`), so it
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
  return dropNonProse(storage)
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
    // Storage format is indented XML, so stripping tags leaves the indentation
    // behind as runs of spaces on every line. Harmless to read, but it is
    // embedded and it counts against the chunk budget.
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Removes the elements whose CONTENT is machine configuration rather than
 * writing, before tag-stripping turns that content into prose.
 *
 * Found by running the converter against a real page: a panel macro put
 * `#E3FCEF` — its background colour — at the top of the extracted text, which
 * then got embedded as though it were something the client had written. Macro
 * parameters, attachment and page references, and layout ids are all like this:
 * they sit inside elements, so removing the tags alone promotes them to body
 * text. Every one of them costs vector quality and chunk budget.
 *
 * Whole elements are dropped, content included, rather than being filtered
 * afterwards. There is no way to tell `#E3FCEF` from a legitimate mention of a
 * colour once the markup is gone.
 */
function dropNonProse(storage: string): string {
  return (
    storage
      // Macro configuration: colours, ids, widths, sort orders.
      .replace(/<ac:parameter\b[^>]*>[\s\S]*?<\/ac:parameter>/gi, "")
      // Task bookkeeping. The task BODY is writing and must survive; its id and
      // status are not, and tag-stripping alone turns them into a stray "11"
      // and "incomplete" sitting in the middle of a sentence.
      .replace(/<ac:task-(id|status)\b[^>]*>[\s\S]*?<\/ac:task-\1>/gi, "")
      // Editor placeholder text — prompts from the template, never authored.
      .replace(/<ac:placeholder\b[^>]*>[\s\S]*?<\/ac:placeholder>/gi, "")
      // Resource references — attachment filenames, space keys, user keys.
      .replace(/<ri:[^>]*\/>/gi, "")
      .replace(/<ri:[^>]*>[\s\S]*?<\/ri:[^>]*>/gi, "")
      // ADF macro configuration. NOT ac:layout-section or ac:layout-cell, which
      // look like structure but CONTAIN the page body — dropping those would
      // silently empty every page that uses a layout, which is most of them.
      .replace(/<ac:(adf-attribute|adf-parameter)\b[^>]*>[\s\S]*?<\/ac:\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  );
}

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, "").trim();
