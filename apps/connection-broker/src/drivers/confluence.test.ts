import { describe, expect, it, vi } from "vitest";
import { ConfluenceDriver, isApiToken, storageToMarkdown, type FetchLike } from "./confluence.js";
import { PermanentError, PermissionDeniedError, TransientError } from "./types.js";

function respond(
  status: number,
  body: unknown = {},
  text?: string,
): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  };
}

const SITE = "https://example.atlassian.net/wiki";
const GATEWAY = "https://gateway.test";
const CLOUD_ID = "cloud-123";
/** v2 addresses pages by space ID; the Connection is still written with the key. */
const SPACE_ID = "1952415750";

/** A page in the shape the v2 API actually returns (verified against a tenant). */
function page(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345",
    title: "Auth design",
    spaceId: SPACE_ID,
    version: { number: 7, createdAt: "2026-09-01T10:00:00Z" },
    _links: { webui: "/spaces/GLOBEX/pages/12345" },
    ...overrides,
  };
}

/** The v1 read-restriction shape, which is still the only one that answers. */
function restrictions(users: string[] = [], groups: string[] = []) {
  return {
    operation: "read",
    restrictions: {
      user: { results: users.map((accountId) => ({ accountId })) },
      group: { results: groups.map((id) => ({ id })) },
    },
  };
}

interface Routes {
  resources?: Awaited<ReturnType<FetchLike>>;
  spaces?: Awaited<ReturnType<FetchLike>>;
  restrictions?: Awaited<ReturnType<FetchLike>>;
}

/**
 * Routes the calls every request now sits behind — the cloudId lookup, the
 * space key-to-id resolution, and the separate restrictions read — so each test
 * only describes the response it actually cares about.
 *
 * A single-response mock would answer `accessible-resources` with a page, which
 * is exactly the sort of thing that makes a fetch-mocked suite pass against a
 * driver that cannot talk to the real API.
 */
function router(fetchImpl: FetchLike, routes: Routes = {}): FetchLike {
  return async (url, init) => {
    if (url.includes("accessible-resources")) {
      return routes.resources ?? respond(200, [{ id: CLOUD_ID, url: "https://example.atlassian.net" }]);
    }
    if (url.includes("/api/v2/spaces")) {
      return routes.spaces ?? respond(200, { results: [{ id: SPACE_ID, key: "GLOBEX" }] });
    }
    if (url.includes("/restriction/byOperation/read")) {
      return routes.restrictions ?? respond(200, restrictions());
    }
    return fetchImpl(url, init);
  };
}

function driverWith(fetchImpl: FetchLike, routes: Routes = {}) {
  return new ConfluenceDriver({
    siteBaseUrl: SITE,
    gatewayOrigin: GATEWAY,
    fetch: router(fetchImpl, routes),
  });
}

describe("the OAuth gateway", () => {
  it("sends API calls to the gateway with the site's cloudId, not to the site", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    await driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "12345");

    const [url] = http.mock.calls[0]!;
    // A 3LO token is accepted only at the gateway; calling the site host
    // returns 401 however valid the token is.
    expect(url).toContain(`${GATEWAY}/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages`);
    expect(url).not.toContain("example.atlassian.net");
  });

  it("builds citations from the SITE, which is what a human can open", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    const result = await driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "12345");

    expect(result.url).toBe("https://example.atlassian.net/wiki/spaces/GLOBEX/pages/12345");
    // A citation pointing at api.atlassian.com is a link nobody can follow.
    expect(result.url).not.toContain(GATEWAY);
  });

  it("ignores _links.base, which on a custom domain is not the domain anyone uses", async () => {
    const routed: FetchLike = async (url) =>
      url.includes("accessible-resources")
        ? respond(200, [{ id: "canonical", url: "https://bitovi.atlassian.net" }])
        : url.includes("/api/v2/spaces")
          ? respond(200, { results: [{ id: SPACE_ID, key: "GLOBEX" }] })
          : respond(200, page({ _links: { webui: "/x/abc", base: "https://bitovi.atlassian.net/wiki" } }));
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com/wiki",
      // Named, because a custom domain can no longer be inferred.
      cloudId: "canonical",
      gatewayOrigin: GATEWAY,
      fetch: routed,
    });

    const result = await driver.probe({ space: "GLOBEX" }, { delegated: "user" }, "12345");

    // A tenant on a custom domain reports its CANONICAL address here. Following
    // it produces a citation that resolves but that nobody recognises, and that
    // SSO may not even let them reach.
    expect(result.url).toBe("https://wiki.at.bitovi.com/wiki/x/abc");
  });

  it("resolves the cloudId once and reuses it", async () => {
    let lookups = 0;
    const routed: FetchLike = async (url) => {
      if (url.includes("accessible-resources")) {
        lookups += 1;
        return respond(200, [{ id: CLOUD_ID, url: "https://example.atlassian.net" }]);
      }
      if (url.includes("/api/v2/spaces")) return respond(200, { results: [{ id: SPACE_ID, key: "GLOBEX" }] });
      return respond(200, page());
    };
    const driver = new ConfluenceDriver({ siteBaseUrl: SITE, gatewayOrigin: GATEWAY, fetch: routed });

    await driver.probe({ space: "GLOBEX" }, { delegated: "a" }, "1");
    await driver.probe({ space: "GLOBEX" }, { delegated: "b" }, "2");

    // cloudId is a property of the site, identical for every caller — looking
    // it up per user would add a round trip to every turn.
    expect(lookups).toBe(1);
  });

  it("refuses a custom domain with no cloudId, even when only one site is reachable", async () => {
    // The origin check has already failed by this point, so nothing has
    // confirmed the one reachable site is the configured tenant. A credential
    // provisioned for a DIFFERENT single-tenant org satisfies this case
    // exactly — and since cloudId is cached for every later caller, trusting it
    // would point the whole connection at another org with every subsequent
    // scope check passing against that org's space.
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com",
      gatewayOrigin: GATEWAY,
      fetch: router(async () => respond(200, page()), {
        resources: respond(200, [{ id: "someone-elses-cloud", url: "https://other-org.atlassian.net" }]),
      }),
    });

    await expect(driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("serves a custom domain once its cloudId is named", async () => {
    // The supported path for a custom domain: one field, which the verify
    // script prints.
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com/wiki",
      cloudId: "named-cloud",
      gatewayOrigin: GATEWAY,
      fetch: router(async () => respond(200, page())),
    });

    const result = await driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1");
    expect(result.allowed).toBe(true);
  });

  it("still refuses a canonical URL that does not match, however few sites there are", async () => {
    // Both sides canonical means they should have matched; a mismatch here is a
    // credential for a DIFFERENT site, not a custom-domain artifact.
    const driver = driverWith(async () => respond(200, page()), {
      resources: respond(200, [{ id: "other", url: "https://someone-else.atlassian.net" }]),
    });

    await expect(driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("refuses to guess when several sites are reachable and none match", async () => {
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com",
      gatewayOrigin: GATEWAY,
      fetch: router(async () => respond(200, page()), {
        resources: respond(200, [
          { id: "a", url: "https://one.atlassian.net" },
          { id: "b", url: "https://two.atlassian.net" },
        ]),
      }),
    });

    // Here the ambiguity is real: picking one would read another tenant's
    // content while every scope check still passed.
    await expect(driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1")).rejects.toThrow(
      /set the connection's cloudId/,
    );
  });

  it("skips discovery entirely when the cloudId is configured", async () => {
    let lookups = 0;
    const routed: FetchLike = async (url) => {
      if (url.includes("accessible-resources")) lookups += 1;
      if (url.includes("/api/v2/spaces")) return respond(200, { results: [{ id: SPACE_ID, key: "GLOBEX" }] });
      return respond(200, page());
    };
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com",
      cloudId: "known-cloud",
      gatewayOrigin: GATEWAY,
      fetch: routed,
    });

    await driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1");
    expect(lookups).toBe(0);
  });

  it("says so when the credential reaches no site at all", async () => {
    const driver = driverWith(async () => respond(200, page()), { resources: respond(200, []) });

    // Distinct from "wrong site": the app is probably not installed.
    await expect(driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1")).rejects.toThrow(
      /may not be installed/,
    );
  });
});

describe("resolving the space key", () => {
  it("translates the configured KEY into the id v2 addresses pages by", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [page()] }));

    await driverWith(http).list({ space: "GLOBEX" }, { service: "svc" }, undefined);

    // The Connection stays written in terms of the key, which is what a human
    // knows the space by; exactly one translation happens, here.
    const [url] = http.mock.calls[0]!;
    expect(url).toContain(`space-id=${SPACE_ID}`);
    expect(url).not.toContain("GLOBEX");
  });

  it("resolves the space id once and reuses it", async () => {
    let lookups = 0;
    const routed: FetchLike = async (url) => {
      if (url.includes("accessible-resources")) {
        return respond(200, [{ id: CLOUD_ID, url: "https://example.atlassian.net" }]);
      }
      if (url.includes("/api/v2/spaces")) {
        lookups += 1;
        return respond(200, { results: [{ id: SPACE_ID, key: "GLOBEX" }] });
      }
      if (url.includes("/restriction/")) return respond(200, restrictions());
      return respond(200, page());
    };
    const driver = new ConfluenceDriver({ siteBaseUrl: SITE, gatewayOrigin: GATEWAY, fetch: routed });

    await driver.probe({ space: "GLOBEX" }, { delegated: "a" }, "1");
    await driver.probe({ space: "GLOBEX" }, { delegated: "b" }, "2");

    // A property of the site, not of the caller.
    expect(lookups).toBe(1);
  });

  it("refuses when the space is not visible to the credential", async () => {
    // Without an id there is nothing to scope against, so every later boundary
    // check would be evaluating against undefined.
    const driver = driverWith(async () => respond(200, page()), {
      spaces: respond(200, { results: [] }),
    });

    await expect(driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1")).rejects.toThrow(
      /not visible to this credential/,
    );
  });

  it("matches on the key rather than trusting the first result", async () => {
    // A filter that quietly returned something else would scope every later
    // check to the wrong space.
    const driver = driverWith(async () => respond(200, page()), {
      spaces: respond(200, { results: [{ id: "999", key: "OTHER" }] }),
    });

    await expect(driver.probe({ space: "GLOBEX" }, { delegated: "u" }, "1")).rejects.toThrow(
      /not visible to this credential/,
    );
  });
});

describe("scope validation", () => {
  const driver = driverWith(vi.fn());

  it("requires a space", () => {
    expect(() => driver.validateScope({})).toThrow(/scoped to a space/);
  });

  it("rejects a scope that also names another provider's unit", () => {
    expect(() => driver.validateScope({ space: "GLOBEX", channel: "C123" })).toThrow(/nothing else/);
  });

  it("rejects a space key that would escape the URL path", () => {
    // Scope is the security boundary; a key reaching a URL is constrained, not
    // trusted.
    expect(() => driver.validateScope({ space: "../../admin" })).toThrow(/illegal/);
  });
});

describe("list", () => {
  it("captures read restrictions as ACL principals", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [page()] }));

    const { resources } = await driverWith(http, {
      restrictions: respond(200, restrictions(["acc-1"], ["grp-1"])),
    }).list({ space: "GLOBEX" }, { service: "svc" }, undefined);

    expect(resources[0]!.acl).toEqual({ principals: ["user:acc-1", "group:grp-1"] });
    expect(resources[0]!.version).toBe("7");
    expect(resources[0]!.url).toBe("https://example.atlassian.net/wiki/spaces/GLOBEX/pages/12345");
  });

  it("reads restrictions from the v1 endpoint, the only one that answers", async () => {
    const seen: string[] = [];
    // Records every URL including the ones the shared router would absorb,
    // because the call under test is exactly one of those.
    const driver = new ConfluenceDriver({
      siteBaseUrl: SITE,
      gatewayOrigin: GATEWAY,
      fetch: async (url) => {
        seen.push(url);
        if (url.includes("accessible-resources")) {
          return respond(200, [{ id: CLOUD_ID, url: "https://example.atlassian.net" }]);
        }
        if (url.includes("/api/v2/spaces")) return respond(200, { results: [{ id: SPACE_ID, key: "GLOBEX" }] });
        if (url.includes("/restriction/")) return respond(200, restrictions(["acc-1"]));
        return respond(200, { results: [page()] });
      },
    });

    const { resources } = await driver.list({ space: "GLOBEX" }, { service: "svc" }, undefined);

    // v2's own /pages/{id}/restrictions returns 401 under these scopes while
    // the v1 path answers, so the obvious cleanup of "move everything to v2"
    // silently empties the mirror.
    expect(seen).toContainEqual(expect.stringContaining("/rest/api/content/12345/restriction/byOperation/read"));
    expect(seen.every((url) => !url.includes("/api/v2/pages/12345/restrictions"))).toBe(true);
    expect(resources[0]!.acl).toEqual({ principals: ["user:acc-1"] });
  });

  it("marks a page with no explicit restrictions PERMISSIVE rather than guessing", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [page()] }));

    const { resources } = await driverWith(http).list({ space: "GLOBEX" }, { service: "svc" }, undefined);

    // Space-level permissions govern here and this driver does not resolve
    // them. Over-inclusion costs a wasted probe; under-inclusion silently
    // suppresses results the user was entitled to see (ADR 0040).
    expect(resources[0]!.acl).toEqual({ principals: [], permissive: true });
  });

  it("degrades to permissive when the restrictions read fails", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [page()] }));

    const { resources } = await driverWith(http, { restrictions: respond(500) }).list(
      { space: "GLOBEX" },
      { service: "svc" },
      undefined,
    );

    // The mirror is a pre-filter, never the decision. A missing entry costs a
    // wasted probe; a wrongly restrictive one hides a page the caller can read.
    expect(resources[0]!.acl).toEqual({ principals: [], permissive: true });
  });

  it("carries the opaque cursor through from the next link", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(200, {
        results: [page()],
        _links: { next: "/wiki/api/v2/pages?limit=3&space-id=1952415750&cursor=abc123" },
      }),
    );

    const { cursor } = await driverWith(http).list({ space: "GLOBEX" }, { service: "svc" }, undefined);

    // v2 paginates by opaque cursor. Reconstructing one would couple us to an
    // encoding Atlassian does not promise to keep.
    expect(cursor).toBe("abc123");
  });

  it("survives a cursor containing a literal +", async () => {
    // These cursors are base64, whose alphabet includes `+`. Form-decoding the
    // next link turns that into a space, and list() re-encodes it as %20 — so
    // the token sent back is not the one Confluence issued, and the walk skips
    // or 400s partway through a large space.
    const cursor = "ey+Jd/C9+abc==";
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        respond(200, {
          results: [page()],
          _links: { next: `/wiki/api/v2/pages?limit=3&space-id=${SPACE_ID}&cursor=${cursor}` },
        }),
      )
      .mockResolvedValueOnce(respond(200, { results: [] }));

    const driver = driverWith(http);
    const { cursor: parsed } = await driver.list({ space: "GLOBEX" }, { service: "svc" }, undefined);
    expect(parsed).toBe(cursor);

    await driver.list({ space: "GLOBEX" }, { service: "svc" }, parsed);
    const [resumedUrl] = http.mock.calls[1]!;
    expect(decodeURIComponent(new URL(resumedUrl).searchParams.get("cursor")!)).toBe(cursor);
  });

  it("ends the walk when no next link comes back", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [page()] }));
    const { cursor } = await driverWith(http).list({ space: "GLOBEX" }, { service: "svc" }, undefined);

    // Absence of the link is the only reliable end signal: a short page is not
    // one, since v2 may return fewer results than the limit and still have more.
    expect(cursor).toBeUndefined();
  });

  it("resumes from a supplied cursor", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [] }));
    await driverWith(http).list({ space: "GLOBEX" }, { service: "svc" }, "abc123");

    expect(http.mock.calls[0]![0]).toContain("cursor=abc123");
  });

  it("lists with the SERVICE credential, since ingestion ignores permissions", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [] }));
    await driverWith(http).list({ space: "GLOBEX" }, { service: "svc", delegated: "user" }, undefined);

    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("space-id="),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer svc" }) }),
    );
  });
});

describe("probe", () => {
  it("returns the citation fields from the source", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    const result = await driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user-token" }, "12345");

    expect(result).toEqual({
      allowed: true,
      title: "Auth design",
      url: "https://example.atlassian.net/wiki/spaces/GLOBEX/pages/12345",
      version: "7",
    });
  });

  it("uses the CALLING USER's token, not the service credential", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    await driverWith(http).probe({ space: "GLOBEX" }, { service: "svc", delegated: "user-token" }, "12345");

    expect(http).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer user-token" }),
      }),
    );
  });

  it("refuses to probe without a delegated token", async () => {
    // Probing with the service credential answers a different question, and
    // answers it permissively.
    await expect(
      driverWith(vi.fn()).probe({ space: "GLOBEX" }, { service: "svc" }, "12345"),
    ).rejects.toThrow(/delegated token/);
  });

  it("does not pull the body — that is the model's own call to make", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));
    await driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "12345");

    const [url] = http.mock.calls[0]!;
    expect(url).not.toContain("body-format");
  });

  it("does not read restrictions — reaching 200 under the user's token IS the decision", async () => {
    const seen: string[] = [];
    const driver = new ConfluenceDriver({
      siteBaseUrl: SITE,
      gatewayOrigin: GATEWAY,
      fetch: router(async (url) => {
        seen.push(url);
        return respond(200, page());
      }),
    });

    await driver.probe({ space: "GLOBEX" }, { delegated: "user" }, "12345");

    // Consulting the mirror here would be both slower and weaker than the
    // answer the source just gave (ADR 0040).
    expect(seen.some((url) => url.includes("/restriction/"))).toBe(false);
  });

  it("refuses a page outside the connection's scope", async () => {
    // A page id alone would otherwise reach any space this credential can see.
    const http = vi.fn().mockResolvedValue(respond(200, page({ spaceId: "99999" })));

    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails CLOSED when the response carries no space id", async () => {
    // Continuing on a boundary check we could not evaluate is the one direction
    // this must never fail in.
    const http = vi.fn().mockResolvedValue(respond(200, page({ spaceId: undefined })));

    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("compares space ids as strings, since v2 is inconsistent about quoting them", async () => {
    // A numeric id that failed to match would fail closed rather than open —
    // but it would fail on every page in the space.
    const http = vi.fn().mockResolvedValue(respond(200, page({ spaceId: Number(SPACE_ID) })));

    const result = await driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "12345");
    expect(result.allowed).toBe(true);
  });
});

describe("error classification", () => {
  it.each([403, 404])("treats %i as a denial", async (status) => {
    const http = vi.fn().mockResolvedValue(respond(status));
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("does NOT treat 401 as a denial, however much it looks like one", async () => {
    // 403/404 is "this user may not read this page". 401 is "this credential
    // was rejected" — expired, wrong audience, wrong scope — which says nothing
    // about what the user may see. Calling it a denial silently shrinks every
    // answer the moment a token goes stale.
    const http = vi.fn().mockResolvedValue(respond(401));
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it.each([429, 500, 503])("treats %i as transient, NOT a denial", async (status) => {
    // Counting a busy source as a denial would quietly shrink an answer and
    // make the same question return different evidence on a retry.
    const http = vi.fn().mockResolvedValue(respond(status));
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("treats 410 as PERMANENT, not transient", async () => {
    // The failure that made the v1 migration expensive. Retrying a withdrawn
    // endpoint reports "temporarily unavailable" forever about something that
    // is never coming back.
    const http = vi.fn().mockResolvedValue(
      respond(410, {}, '{"message":"GoneException: This deprecated endpoint has been removed."}'),
    );
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("carries the provider's own explanation into the error", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(401, {}, '{"code":401,"message":"Unauthorized; scope does not match"}'),
    );

    // `scope does not match` and `endpoint has been removed` are the same
    // 4xx-shaped failure from the outside and have completely different fixes.
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toThrow(/scope does not match/);
  });

  it("truncates a long error body rather than pasting it into the message", async () => {
    const http = vi.fn().mockResolvedValue(respond(500, {}, "x".repeat(5000)));

    // An HTML error page from a proxy in front of the API is a realistic body.
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toThrow(/^confluence returned 500: x{300}$/);
  });

  it("still fails the original way when the error body cannot be read", async () => {
    const http = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => {
        throw new Error("stream already consumed");
      },
    });

    // Failing to read WHY something failed must not replace the failure with a
    // different one.
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("treats a network failure as transient", async () => {
    const http = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      driverWith(http).probe({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("fetch", () => {
  it("prefers the delegated token when a user is reading", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(200, page({ body: { storage: { value: "<p>hello</p>" } } })),
    );

    const doc = await driverWith(http).fetch(
      { space: "GLOBEX" },
      { service: "svc", delegated: "user-token" },
      "12345",
    );

    expect(doc.markdown).toBe("hello");
    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("body-format=storage"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer user-token" }),
      }),
    );
  });

  it("refuses a page outside the connection's scope", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page({ spaceId: "99999" })));
    await expect(
      driverWith(http).fetch({ space: "GLOBEX" }, { service: "svc" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails CLOSED when the response carries no space id", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page({ spaceId: undefined })));
    await expect(
      driverWith(http).fetch({ space: "GLOBEX" }, { service: "svc" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("storageToMarkdown", () => {
  it("keeps enough structure for chunking to cut on", () => {
    const markdown = storageToMarkdown(
      "<h2>Auth</h2><p>We use OIDC.</p><ul><li>Pocket ID</li><li>Google</li></ul>",
    );
    expect(markdown).toContain("## Auth");
    expect(markdown).toContain("We use OIDC.");
    expect(markdown).toContain("- Pocket ID");
  });

  it("decodes entities and drops residual markup", () => {
    expect(storageToMarkdown("<p>a &amp; b &lt;c&gt;</p>")).toBe("a & b <c>");
  });
});

describe("storageToMarkdown against real Confluence storage format", () => {
  it("drops macro parameters, which are configuration rather than writing", () => {
    // Found by running the converter against a real page: a panel macro put
    // its background colour at the top of the extracted text, where it was
    // embedded as though the client had written it.
    const markdown = storageToMarkdown(
      '<ac:structured-macro ac:name="panel">' +
        '<ac:parameter ac:name="bgColor">#E3FCEF</ac:parameter>' +
        "<ac:rich-text-body><h2>Welcome</h2><p>Real content.</p></ac:rich-text-body>" +
        "</ac:structured-macro>",
    );

    expect(markdown).not.toContain("#E3FCEF");
    expect(markdown).toContain("## Welcome");
    expect(markdown).toContain("Real content.");
  });

  it("KEEPS the content of layout cells, which hold the page body", () => {
    // ac:layout-cell looks like structure but contains the writing. Dropping it
    // the way ac:parameter is dropped would silently empty most pages.
    const markdown = storageToMarkdown(
      "<ac:layout><ac:layout-section ac:type=\"two_equal\"><ac:layout-cell>" +
        "<p>Left column text.</p></ac:layout-cell><ac:layout-cell>" +
        "<p>Right column text.</p></ac:layout-cell></ac:layout-section></ac:layout>",
    );

    expect(markdown).toContain("Left column text.");
    expect(markdown).toContain("Right column text.");
  });

  it("drops resource references, which are filenames and keys", () => {
    const markdown = storageToMarkdown(
      '<p>See <ac:image><ri:attachment ri:filename="diagram-v3-FINAL.png" /></ac:image> here.</p>',
    );
    expect(markdown).not.toContain("diagram-v3-FINAL.png");
    expect(markdown).toContain("See");
  });

  it("collapses the indentation storage format carries", () => {
    // Stripping tags from indented XML leaves runs of spaces on every line,
    // which are embedded and count against the chunk budget.
    const markdown = storageToMarkdown("<p>\n        Indented sentence.\n      </p>");
    expect(markdown).toBe("Indented sentence.");
  });

  it("leaves a genuine mention of a colour alone", () => {
    // The reason whole elements are dropped rather than filtered afterwards:
    // once the markup is gone there is no telling the two apart.
    expect(storageToMarkdown("<p>Use #E3FCEF for the banner.</p>")).toBe("Use #E3FCEF for the banner.");
  });
});

describe("storageToMarkdown task lists", () => {
  it("keeps the task text but not its id and status", () => {
    // Found on a real page: tag-stripping alone left a stray "11" and
    // "incomplete" sitting in the middle of the extracted prose.
    const markdown = storageToMarkdown(
      "<ac:task-list><ac:task><ac:task-id>11</ac:task-id>" +
        "<ac:task-status>incomplete</ac:task-status>" +
        "<ac:task-body>Click the edit icon</ac:task-body></ac:task></ac:task-list>",
    );

    expect(markdown).toContain("Click the edit icon");
    expect(markdown).not.toMatch(/\bincomplete\b/);
    expect(markdown).not.toMatch(/\b11\b/);
  });

  it("drops editor placeholder prompts, which nobody authored", () => {
    const markdown = storageToMarkdown(
      "<p><ac:placeholder>Type your notes here</ac:placeholder>Actual note.</p>",
    );
    expect(markdown).toBe("Actual note.");
  });
});

describe("service credential shape", () => {
  /** Captures the headers and URL of the first call. */
  function capture(body: unknown = { results: [{ id: "1", key: "GLOBEX" }] }) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => "",
    })) as unknown as FetchLike;
  }

  it("uses Basic auth and the SITE for an API token", async () => {
    // An OAuth access token expires in about an hour and nothing in the broker
    // refreshes a service credential, so a long-lived API token is what makes
    // unattended ingestion possible at all (docs/adr/0044).
    const http = capture();
    const driver = new ConfluenceDriver({
      fetch: http,
      siteBaseUrl: "https://bitovi.atlassian.net/wiki",
      cloudId: "cloud-1",
    });

    await driver.list({ space: "GLOBEX" }, { service: "bot@bitovi.com:api-token-value" }, undefined);

    const [url, init] = (http as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // Direct to the site: accessible-resources is an OAuth endpoint and does
    // not answer for Basic auth, so the gateway path would fail before the
    // first real call.
    expect(String(url)).toContain("https://bitovi.atlassian.net/wiki");
    expect(String(url)).not.toContain("api.atlassian.com");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("bot@bitovi.com:api-token-value").toString("base64")}`,
    });
  });

  it("uses Bearer and the OAuth gateway for an access token", async () => {
    const http = capture();
    const driver = new ConfluenceDriver({
      fetch: http,
      siteBaseUrl: "https://bitovi.atlassian.net/wiki",
      cloudId: "cloud-1",
    });

    await driver.list({ space: "GLOBEX" }, { service: "oauth-access-token" }, undefined);

    const [url, init] = (http as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain("api.atlassian.com/ex/confluence/cloud-1/wiki");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer oauth-access-token",
    });
  });

  it("does not mistake an OAuth token containing a colon for an API token", async () => {
    // The discriminator is the `@` in the first half, not the colon alone:
    // an opaque token may contain punctuation, and guessing wrong here sends
    // a valid credential to the wrong host with the wrong scheme.
    expect(isApiToken("abc:def")).toBe(false);
    expect(isApiToken("bot@bitovi.com:secret")).toBe(true);
    expect(isApiToken("no-separator")).toBe(false);
    expect(isApiToken(":leading")).toBe(false);
  });
});
