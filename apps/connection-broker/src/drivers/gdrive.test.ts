import { describe, expect, it, vi } from "vitest";
import { GDriveDriver } from "./gdrive.js";
import { PermanentError, PermissionDeniedError, TransientError } from "./types.js";
import type { FetchLike } from "./confluence.js";

const SCOPE = { folderID: "FOLDER1" };

function respond(body: unknown, status = 200, text?: string): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  };
}

const file = (overrides: Record<string, unknown> = {}) => ({
  id: "FILE1",
  name: "Architecture decisions",
  mimeType: "application/vnd.google-apps.document",
  modifiedTime: "2026-09-01T10:00:00Z",
  version: "12",
  webViewLink: "https://docs.google.com/document/d/FILE1/edit",
  parents: ["FOLDER1"],
  ...overrides,
});

const driver = (http: FetchLike) => new GDriveDriver({ fetch: http });

describe("scope validation", () => {
  const d = driver(vi.fn());

  it("requires a folder", () => {
    expect(() => d.validateScope({})).toThrow(/scoped to a folder/);
  });

  it("rejects an id that would break out of the query term", () => {
    // The folder id is interpolated into a quoted query term, where an
    // apostrophe would end the quote and let the rest read as query syntax.
    expect(() => d.validateScope({ folderID: "x' or '1'='1" })).toThrow(/illegal/);
  });
});

describe("list", () => {
  it("skips folders and binaries, which embed as noise", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({
        files: [
          file(),
          file({ id: "SUB", mimeType: "application/vnd.google-apps.folder" }),
          file({ id: "IMG", mimeType: "image/png" }),
          file({ id: "TXT", mimeType: "text/plain" }),
        ],
      }),
    );

    const { resources } = await driver(http).list(SCOPE, { service: "t" }, undefined);
    expect(resources.map((r) => r.id)).toEqual(["FILE1", "TXT"]);
  });

  it("uses Drive's own revision counter as the version", async () => {
    const http = vi.fn().mockResolvedValue(respond({ files: [file()] }));
    const { resources } = await driver(http).list(SCOPE, { service: "t" }, undefined);
    expect(resources[0]!.version).toBe("12");
  });

  it("carries the page token through as the cursor", async () => {
    const http = vi.fn().mockResolvedValue(respond({ files: [], nextPageToken: "tok-2" }));
    const { cursor } = await driver(http).list(SCOPE, { service: "t" }, undefined);
    expect(cursor).toBe("tok-2");
  });
});

describe("scope enforcement", () => {
  it("accepts a file whose parent IS the folder", async () => {
    const http = vi.fn().mockResolvedValue(respond(file()));
    const result = await driver(http).probe(SCOPE, { delegated: "u" }, "FILE1");
    expect(result.allowed).toBe(true);
  });

  it("accepts a file nested deeper, by walking parents up", async () => {
    // Drive has no "descendant of" predicate, so membership is a walk.
    const http = vi.fn(async (url: string) => {
      if (url.includes("FILE1")) return respond(file({ parents: ["MID"] }));
      if (url.includes("MID")) return respond({ id: "MID", parents: ["FOLDER1"] });
      return respond({});
    });
    const result = await driver(http as unknown as FetchLike).probe(SCOPE, { delegated: "u" }, "FILE1");
    expect(result.allowed).toBe(true);
  });

  it("refuses a file in another folder", async () => {
    const http = vi.fn().mockResolvedValue(respond(file({ parents: ["SOMEONE_ELSE"] })));
    await expect(
      driver(http).probe(SCOPE, { delegated: "u" }, "FILE1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails CLOSED when a file reports no parents", async () => {
    const http = vi.fn().mockResolvedValue(respond(file({ parents: undefined })));
    await expect(
      driver(http).probe(SCOPE, { delegated: "u" }, "FILE1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("terminates on a parent cycle instead of walking forever", async () => {
    // Shortcuts and shared drives make cycles reachable, and an unbounded walk
    // there is a denial of service we would run against ourselves.
    const http = vi.fn(async (url: string) => {
      if (url.includes("FILE1")) return respond(file({ parents: ["A"] }));
      if (url.includes("/files/A")) return respond({ id: "A", parents: ["B"] });
      return respond({ id: "B", parents: ["A"] });
    });

    await expect(
      driver(http as unknown as FetchLike).probe(SCOPE, { delegated: "u" }, "FILE1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("fetch", () => {
  it("EXPORTS a Google Doc, which has no bytes to download", async () => {
    const http = vi.fn(async (url: string) => {
      if (url.includes("/export")) return respond({}, 200, "The decision was to use OIDC.");
      return respond(file());
    });

    const doc = await driver(http as unknown as FetchLike).fetch(SCOPE, { service: "t" }, "FILE1");

    expect(doc.markdown).toBe("The decision was to use OIDC.");
    expect(http.mock.calls.some(([url]) => url.includes("mimeType=text%2Fplain"))).toBe(true);
  });

  it("downloads a plain text file directly", async () => {
    const http = vi.fn(async (url: string) => {
      if (url.includes("alt=media")) return respond({}, 200, "plain contents");
      return respond(file({ mimeType: "text/plain" }));
    });

    const doc = await driver(http as unknown as FetchLike).fetch(SCOPE, { service: "t" }, "FILE1");
    expect(doc.markdown).toBe("plain contents");
  });
});

describe("error classification", () => {
  it("treats a quota 403 as TRANSIENT, not a denial", async () => {
    // 403 is overloaded in Drive. Reading a quota exhaustion as "you may not"
    // would silently shrink an answer and make retries disagree.
    const http = vi.fn().mockResolvedValue(
      respond({}, 403, JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } })),
    );
    await expect(
      driver(http).probe(SCOPE, { delegated: "u" }, "FILE1"),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("treats a permission 403 as a denial", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({}, 403, JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } })),
    );
    await expect(
      driver(http).probe(SCOPE, { delegated: "u" }, "FILE1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("treats 401 as permanent", async () => {
    const http = vi.fn().mockResolvedValue(respond({}, 401));
    await expect(
      driver(http).probe(SCOPE, { delegated: "u" }, "FILE1"),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("treats 5xx as transient", async () => {
    const http = vi.fn().mockResolvedValue(respond({}, 503));
    await expect(
      driver(http).probe(SCOPE, { delegated: "u" }, "FILE1"),
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("searchAsUser", () => {
  it("escapes an apostrophe rather than letting it close the query literal", async () => {
    // `fullText contains '...'` is a single-quoted literal and the words are
    // the CALLER's. This is the same lesson the folder id taught.
    const http = vi.fn(async () => respond({ files: [] })) as unknown as FetchLike;
    await driver(http).searchAsUser({ delegated: "u" }, { folderID: "F1" }, "the client's brief");

    const url = String((http as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(decodeURIComponent(url).replace(/\+/g, " ")).toContain("fullText contains 'the client\\'s brief'");
  });

  it("keeps only files whose parent chain reaches the scoped folder", async () => {
    // `'<id>' in parents` is one level and the corpus is recursive, so the
    // query cannot express the bound; the walk does.
    const http = vi.fn(async (url: string) => {
      if (url.includes("fullText")) {
        return respond({
          files: [
            { id: "inside", name: "Brief", mimeType: "text/plain", parents: ["SUB"] },
            { id: "outside", name: "Other", mimeType: "text/plain", parents: ["ELSEWHERE"] },
          ],
        });
      }
      if (url.includes("/files/SUB")) return respond({ id: "SUB", parents: ["F1"] });
      if (url.includes("/files/ELSEWHERE")) return respond({ id: "ELSEWHERE", parents: [] });
      return respond({});
    }) as unknown as FetchLike;

    const hits = await driver(http).searchAsUser({ delegated: "u" }, { folderID: "F1" }, "brief");

    expect(hits.map((h) => h.id)).toEqual(["inside"]);
  });

  it("refuses the service credential", async () => {
    await expect(
      driver(vi.fn() as unknown as FetchLike).searchAsUser({ service: "s" }, { folderID: "F1" }, "x"),
    ).rejects.toThrow(/delegated token/);
  });
});

describe("recursive listing", () => {
  /** Answers folder-enumeration queries and the file query separately. */
  function tree(children: Record<string, { id: string }[]>, files: unknown[]) {
    return vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(String(url)).searchParams.get("q") ?? "");
      const folderQuery = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      if (folderQuery) {
        const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? "";
        return respond({ files: children[parent] ?? [] });
      }
      return respond({ files });
    }) as unknown as FetchLike;
  }

  it("lists files in SUBFOLDERS, not just direct children", async () => {
    // Found live: two of two nested documents were missing. `fetch` walks a
    // parent chain sixteen deep and would happily serve them, so they were
    // readable and could never be indexed — absent with nothing to say so.
    const http = tree(
      { F1: [{ id: "SUB" }], SUB: [] },
      [
        { id: "top", name: "Top", mimeType: "text/plain", parents: ["F1"] },
        { id: "nested", name: "Nested", mimeType: "text/plain", parents: ["SUB"] },
      ],
    );

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources.map((r) => r.id)).toEqual(["top", "nested"]);

    // Every folder in the tree is named as a parent, since Drive has no
    // "at any depth" operator.
    const fileQuery = (http as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => decodeURIComponent(new URL(String(c[0])).searchParams.get("q") ?? ""))
      .find((q: string) => !q.includes("google-apps.folder"))!;
    expect(fileQuery).toContain("'F1' in parents");
    expect(fileQuery).toContain("'SUB' in parents");
  });

  it("enumerates the tree once per sync, not once per page", async () => {
    const http = tree({ F1: [{ id: "SUB" }], SUB: [] }, []);
    const d = driver(http);

    await d.list({ folderID: "F1" }, { service: "t" }, undefined);
    const afterFirst = (http as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await d.list({ folderID: "F1" }, { service: "t" }, "page-2");
    const afterSecond = (http as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // The second page costs exactly one call: the file query.
    expect(afterSecond - afterFirst).toBe(1);
  });

  it("does not loop on a cycle", async () => {
    // A shortcut can point back up the tree.
    const http = tree({ F1: [{ id: "SUB" }], SUB: [{ id: "F1" }] }, []);

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources).toEqual([]);
  });

  it("refuses a tree too wide to express, rather than truncating it", async () => {
    // Quietly dropping folders would under-index a client's corpus and look
    // like an empty subfolder — the exact failure the recursion fixes.
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `f${i}` }));
    const http = tree({ F1: many }, []);

    await expect(
      driver(http).list({ folderID: "F1" }, { service: "t" }, undefined),
    ).rejects.toThrow(/narrower folder/);
  });

  it("stops walking rather than spinning when a page token never clears", async () => {
    // A provider that always returns a nextPageToken would otherwise hang the
    // sync, which is harder to diagnose than a sync that stops.
    const http = vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(String(url)).searchParams.get("q") ?? "");
      if (q.includes("google-apps.folder")) {
        return respond({ files: [], nextPageToken: "never-ends" });
      }
      return respond({ files: [] });
    }) as unknown as FetchLike;

    await expect(
      driver(http).list({ folderID: "F1" }, { service: "t" }, undefined),
    ).resolves.toBeDefined();
  });
});
