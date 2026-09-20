import { describe, expect, it, vi } from "vitest";
import { ConfluenceDriver, storageToMarkdown, type FetchLike } from "./confluence.js";
import { PermissionDeniedError, TransientError } from "./types.js";

function respond(status: number, body: unknown = {}): Awaited<ReturnType<FetchLike>> {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345",
    title: "Auth design",
    version: { number: 7, when: "2026-09-01T10:00:00Z" },
    _links: { webui: "/spaces/SNC/pages/12345" },
    space: { key: "SNC" },
    ...overrides,
  };
}

const SITE = "https://example.atlassian.net/wiki";
const GATEWAY = "https://gateway.test";
const CLOUD_ID = "cloud-123";

/**
 * Routes the cloudId lookup the driver now performs before any API call, so
 * each test only has to describe the response it actually cares about. A
 * single-response mock would answer `accessible-resources` with a page, which
 * is exactly the sort of thing that makes a fetch-mocked suite pass against a
 * driver that cannot talk to the real API.
 */
function driverWith(fetchImpl: FetchLike) {
  const routed: FetchLike = async (url, init) => {
    if (url.includes("accessible-resources")) {
      return respond(200, [{ id: CLOUD_ID, url: "https://example.atlassian.net" }]);
    }
    return fetchImpl(url, init);
  };
  return new ConfluenceDriver({ siteBaseUrl: SITE, gatewayOrigin: GATEWAY, fetch: routed });
}

describe("the OAuth gateway", () => {
  it("sends API calls to the gateway with the site's cloudId, not to the site", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    await driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "12345");

    const [url] = http.mock.calls[0]!;
    // A 3LO token is accepted only at the gateway; calling the site host
    // returns 401 however valid the token is.
    expect(url).toContain(`${GATEWAY}/ex/confluence/${CLOUD_ID}/rest/api/content`);
    expect(url).not.toContain("example.atlassian.net");
  });

  it("still builds citations from the SITE, which is what a human can open", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    const result = await driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "12345");

    expect(result.url).toBe("https://example.atlassian.net/wiki/spaces/SNC/pages/12345");
    // A citation pointing at api.atlassian.com is a link nobody can follow.
    expect(result.url).not.toContain(GATEWAY);
  });

  it("prefers the base the response reports over our assumption about it", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(200, page({ _links: { webui: "/x/abc", base: "https://renamed.atlassian.net/wiki" } })),
    );

    const result = await driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "12345");

    // The source describing where its own pages live beats our guess — exactly
    // the assumption most likely to be wrong on first contact with a tenant.
    expect(result.url).toBe("https://renamed.atlassian.net/wiki/x/abc");
  });

  it("resolves the cloudId once and reuses it", async () => {
    let lookups = 0;
    const routed: FetchLike = async (url) => {
      if (url.includes("accessible-resources")) {
        lookups += 1;
        return respond(200, [{ id: CLOUD_ID, url: "https://example.atlassian.net" }]);
      }
      return respond(200, page());
    };
    const driver = new ConfluenceDriver({ siteBaseUrl: SITE, gatewayOrigin: GATEWAY, fetch: routed });

    await driver.probe({ space: "SNC" }, { delegated: "a" }, "1");
    await driver.probe({ space: "SNC" }, { delegated: "b" }, "2");

    // cloudId is a property of the site, identical for every caller — looking
    // it up per user would add a round trip to every turn.
    expect(lookups).toBe(1);
  });

  it("uses the only accessible site when a custom domain cannot match", async () => {
    // wiki.at.bitovi.com is a custom domain; accessible-resources reports the
    // canonical bitovi.atlassian.net, so origin equality finds nothing. With
    // exactly one site there is no ambiguity, and refusing would block the only
    // tenant there is.
    const routed: FetchLike = async (url) =>
      url.includes("accessible-resources")
        ? respond(200, [{ id: "canonical-cloud", url: "https://bitovi.atlassian.net" }])
        : respond(200, page());
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com",
      gatewayOrigin: GATEWAY,
      fetch: routed,
    });

    const result = await driver.probe({ space: "SNC" }, { delegated: "u" }, "1");
    expect(result.allowed).toBe(true);
  });

  it("still refuses a canonical URL that does not match, however few sites there are", async () => {
    // Both sides canonical means they should have matched; a mismatch here is a
    // credential for a DIFFERENT site, not a custom-domain artifact.
    const routed: FetchLike = async (url) =>
      url.includes("accessible-resources")
        ? respond(200, [{ id: "other", url: "https://someone-else.atlassian.net" }])
        : respond(200, page());
    const driver = new ConfluenceDriver({ siteBaseUrl: SITE, gatewayOrigin: GATEWAY, fetch: routed });

    await expect(driver.probe({ space: "SNC" }, { delegated: "u" }, "1")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("refuses to guess when several sites are reachable and none match", async () => {
    const routed: FetchLike = async (url) =>
      url.includes("accessible-resources")
        ? respond(200, [
            { id: "a", url: "https://one.atlassian.net" },
            { id: "b", url: "https://two.atlassian.net" },
          ])
        : respond(200, page());
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com",
      gatewayOrigin: GATEWAY,
      fetch: routed,
    });

    // Here the ambiguity is real: picking one would read another tenant's
    // content while every scope check still passed.
    await expect(driver.probe({ space: "SNC" }, { delegated: "u" }, "1")).rejects.toThrow(
      /set the connection's cloudId/,
    );
  });

  it("skips discovery entirely when the cloudId is configured", async () => {
    let lookups = 0;
    const routed: FetchLike = async (url) => {
      if (url.includes("accessible-resources")) lookups += 1;
      return respond(200, page());
    };
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.at.bitovi.com",
      cloudId: "known-cloud",
      gatewayOrigin: GATEWAY,
      fetch: routed,
    });

    await driver.probe({ space: "SNC" }, { delegated: "u" }, "1");
    expect(lookups).toBe(0);
  });

  it("says so when the credential reaches no site at all", async () => {
    const routed: FetchLike = async (url) =>
      url.includes("accessible-resources") ? respond(200, []) : respond(200, page());
    const driver = new ConfluenceDriver({ siteBaseUrl: SITE, gatewayOrigin: GATEWAY, fetch: routed });

    // Distinct from "wrong site": the app is probably not installed.
    await expect(driver.probe({ space: "SNC" }, { delegated: "u" }, "1")).rejects.toThrow(
      /may not be installed/,
    );
  });

  it("refuses a credential that cannot reach the configured site", async () => {
    const routed: FetchLike = async (url) =>
      url.includes("accessible-resources")
        ? respond(200, [{ id: "other-cloud", url: "https://someone-else.atlassian.net" }])
        : respond(200, page());
    const driver = new ConfluenceDriver({ siteBaseUrl: SITE, gatewayOrigin: GATEWAY, fetch: routed });

    // Taking the first entry would read another tenant's content while every
    // scope check still passed.
    await expect(driver.probe({ space: "SNC" }, { delegated: "u" }, "1")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe("scope validation", () => {
  const driver = driverWith(vi.fn());

  it("requires a space", () => {
    expect(() => driver.validateScope({})).toThrow(/scoped to a space/);
  });

  it("rejects a scope that also names another provider's unit", () => {
    expect(() => driver.validateScope({ space: "SNC", channel: "C123" })).toThrow(/nothing else/);
  });

  it("rejects a space key that would escape the URL path", () => {
    // Scope is the security boundary; a key reaching a URL is constrained, not
    // trusted.
    expect(() => driver.validateScope({ space: "../../admin" })).toThrow(/illegal/);
  });
});

describe("list", () => {
  it("captures read restrictions as ACL principals", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(200, {
        results: [
          page({
            restrictions: {
              read: {
                restrictions: {
                  user: { results: [{ accountId: "acc-1" }] },
                  group: { results: [{ id: "grp-1" }] },
                },
              },
            },
          }),
        ],
      }),
    );

    const { resources } = await driverWith(http).list({ space: "SNC" }, { service: "svc" }, undefined);

    expect(resources[0]!.acl).toEqual({ principals: ["user:acc-1", "group:grp-1"] });
    expect(resources[0]!.version).toBe("7");
    expect(resources[0]!.url).toBe("https://example.atlassian.net/wiki/spaces/SNC/pages/12345");
  });

  it("marks a page with no explicit restrictions PERMISSIVE rather than guessing", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [page()] }));

    const { resources } = await driverWith(http).list({ space: "SNC" }, { service: "svc" }, undefined);

    // Space-level permissions govern here and this driver does not resolve
    // them. Over-inclusion costs a wasted probe; under-inclusion silently
    // suppresses results the user was entitled to see (ADR 0040).
    expect(resources[0]!.acl).toEqual({ principals: [], permissive: true });
  });

  it("ends the walk on a short page", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [page()] }));
    const { cursor } = await driverWith(http).list({ space: "SNC" }, { service: "svc" }, undefined);
    expect(cursor).toBeUndefined();
  });

  it("lists with the SERVICE credential, since ingestion ignores permissions", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { results: [] }));
    await driverWith(http).list({ space: "SNC" }, { service: "svc", delegated: "user" }, undefined);

    expect(http).toHaveBeenCalledWith(
      expect.stringContaining("spaceKey=SNC"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer svc" }) }),
    );
  });
});

describe("probe", () => {
  it("returns the citation fields from the source", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    const result = await driverWith(http).probe({ space: "SNC" }, { delegated: "user-token" }, "12345");

    expect(result).toEqual({
      allowed: true,
      title: "Auth design",
      url: "https://example.atlassian.net/wiki/spaces/SNC/pages/12345",
      version: "7",
    });
  });

  it("uses the CALLING USER's token, not the service credential", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));

    await driverWith(http).probe({ space: "SNC" }, { service: "svc", delegated: "user-token" }, "12345");

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
      driverWith(vi.fn()).probe({ space: "SNC" }, { service: "svc" }, "12345"),
    ).rejects.toThrow(/delegated token/);
  });

  it("does not pull the body — that is the model's own call to make", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page()));
    await driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "12345");

    const [url] = http.mock.calls[0]!;
    expect(url).not.toContain("body.storage");
  });

  it("refuses a page outside the connection's scope", async () => {
    // A page id alone would otherwise reach any space this credential can see.
    const http = vi.fn().mockResolvedValue(respond(200, page({ space: { key: "OTHER" } })));

    await expect(
      driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails CLOSED when the response carries no space key", async () => {
    // The absent-field case, which an earlier `page.space?.key && …` guard
    // short-circuited straight past. Every call site asks for expand=…,space,
    // so a response without it is a contract we no longer recognise — and
    // continuing on a boundary check we could not evaluate is the one direction
    // this must never fail in.
    const http = vi.fn().mockResolvedValue(respond(200, page({ space: undefined })));

    await expect(
      driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails closed when space is present but has no key", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page({ space: {} })));

    await expect(
      driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("error classification", () => {
  it.each([401, 403, 404])("treats %i as a denial", async (status) => {
    const http = vi.fn().mockResolvedValue(respond(status));
    await expect(
      driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each([429, 500, 503])("treats %i as transient, NOT a denial", async (status) => {
    // Counting a busy source as a denial would quietly shrink an answer and
    // make the same question return different evidence on a retry.
    const http = vi.fn().mockResolvedValue(respond(status));
    await expect(
      driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("treats a network failure as transient", async () => {
    const http = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      driverWith(http).probe({ space: "SNC" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("fetch", () => {
  it("prefers the delegated token when a user is reading", async () => {
    const http = vi.fn().mockResolvedValue(
      respond(200, page({ body: { storage: { value: "<p>hello</p>" } } })),
    );

    const doc = await driverWith(http).fetch(
      { space: "SNC" },
      { service: "svc", delegated: "user-token" },
      "12345",
    );

    expect(doc.markdown).toBe("hello");
    expect(http).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer user-token" }),
      }),
    );
  });

  it("refuses a page outside the connection's scope", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page({ space: { key: "OTHER" } })));
    await expect(
      driverWith(http).fetch({ space: "SNC" }, { service: "svc" }, "99999"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails CLOSED when the response carries no space key", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, page({ space: undefined })));
    await expect(
      driverWith(http).fetch({ space: "SNC" }, { service: "svc" }, "99999"),
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
