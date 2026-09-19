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

function driverWith(fetchImpl: FetchLike) {
  return new ConfluenceDriver({ baseUrl: "https://example.atlassian.net/wiki", fetch: fetchImpl });
}

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
