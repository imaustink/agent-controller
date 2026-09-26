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

describe("PDF extraction", () => {
  /**
   * A real, minimal PDF — not a stub.
   *
   * The point of these tests is that unpdf actually reads what Drive hands us,
   * so mocking the extraction would test nothing but the mock.
   */
  const REAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 612 792]/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 68>>stream
BT /F1 18 Tf 72 700 Td (Statement of Work: GLOBEX delivery) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>`;

  function pdfDrive(file: Record<string, unknown>, bytes = REAL_PDF) {
    return vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("alt=media")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          // A standalone ArrayBuffer, not Buffer's shared allocator pool:
          // pdf.js TRANSFERS its input, and a pooled buffer cannot be
          // transferred (and would carry the whole pool's bytes anyway).
          arrayBuffer: async () => Uint8Array.from(Buffer.from(bytes, "latin1")).buffer,
        };
      }
      return respond(file);
    }) as unknown as FetchLike;
  }

  const PDF = {
    id: "pdf1",
    name: "SOW.pdf",
    mimeType: "application/pdf",
    parents: ["F1"],
    size: "12345",
  };

  it("indexes a PDF instead of dropping it", async () => {
    // These were silently skipped: indexable() rejected the mime type and
    // nothing recorded it, so a folder of PDFs indexed as empty.
    const http = pdfDrive(PDF);
    const doc = await driver(http).fetch({ folderID: "F1" }, { service: "t" }, "pdf1");

    expect(doc.markdown).toContain("Statement of Work: GLOBEX delivery");
  });

  it("lists PDFs as indexable", async () => {
    const http = vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(String(url)).searchParams.get("q") ?? "");
      if (q.includes("google-apps.folder")) return respond({ files: [] });
      return respond({ files: [PDF] });
    }) as unknown as FetchLike;

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);
    expect(page.resources.map((r) => r.id)).toEqual(["pdf1"]);
  });

  it("refuses an oversized PDF before downloading it", async () => {
    // Checked against Drive's reported size, so this costs one metadata read
    // rather than a transfer and a parse in a 512Mi container.
    const http = pdfDrive({ ...PDF, size: String(64 * 1024 * 1024) });

    await expect(
      driver(http).fetch({ folderID: "F1" }, { service: "t" }, "pdf1"),
    ).rejects.toThrow(/over the .*limit/);

    const downloaded = (http as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (call: unknown[]) => String(call[0]).includes("alt=media"),
    );
    expect(downloaded).toBe(false);
  });

  it("treats an unparseable PDF as permanent, not retryable", async () => {
    // Encrypted, truncated or malformed does not improve on a second pass, and
    // a sync that retries it forever reports the wrong thing.
    const http = pdfDrive(PDF, "not a pdf at all");

    await expect(
      driver(http).fetch({ folderID: "F1" }, { service: "t" }, "pdf1"),
    ).rejects.toThrow(PermanentError);
  });

  it("names the types it skipped rather than dropping them silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const http = vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(String(url)).searchParams.get("q") ?? "");
      if (q.includes("google-apps.folder")) return respond({ files: [] });
      return respond({
        files: [
          { id: "a", name: "clip.mp4", mimeType: "video/mp4", parents: ["F1"] },
          { id: "b", name: "art.psd", mimeType: "image/vnd.adobe.photoshop", parents: ["F1"] },
        ],
      });
    }) as unknown as FetchLike;

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("video/mp4"));
    warn.mockRestore();
  });

  it("does not announce skipped FOLDERS, which are traversed rather than dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const http = vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(String(url)).searchParams.get("q") ?? "");
      if (q.includes("google-apps.folder")) return respond({ files: [] });
      return respond({
        files: [{ id: "sub", mimeType: "application/vnd.google-apps.folder", parents: ["F1"] }],
      });
    }) as unknown as FetchLike;

    await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("shortcuts", () => {
  const shortcut = (over = {}) => ({
    id: "sc1",
    name: "Notes by Gemini",
    mimeType: "application/vnd.google-apps.shortcut",
    parents: ["F1"],
    shortcutDetails: {
      targetId: "doc1",
      targetMimeType: "application/vnd.google-apps.document",
    },
    ...over,
  });

  /** Folder walk, file listing, then per-id metadata and content. */
  function drive(files, targets = {}) {
    return vi.fn(async (url: string) => {
      const target = String(url);
      const q = decodeURIComponent(new URL(target).searchParams.get("q") ?? "");
      if (q.includes("google-apps.folder")) return respond({ files: [] });
      if (q) return respond({ files });

      for (const [id, meta] of Object.entries(targets)) {
        if (target.includes(`/files/${id}`)) {
          if (target.includes("alt=media") || target.includes("/export")) {
            return { ok: true, status: 200, json: async () => ({}), text: async () => "target body" };
          }
          return respond(meta);
        }
      }
      return respond({});
    }) as unknown as FetchLike;
  }

  it("indexes a shortcut to a document, instead of skipping it", async () => {
    // A live Drive had 54 of these, pointing at meeting notes that are
    // ordinary Docs. Judged by their own mime type, every one was skipped.
    const http = drive([shortcut()], { doc1: { id: "doc1", version: "9" } });

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources.map((r) => r.id)).toEqual(["sc1"]);
  });

  it("still skips a shortcut to something unindexable", async () => {
    // One of the live shortcuts pointed at a video. Following the shortcut
    // must not mean indexing whatever is on the other end.
    const http = drive([
      shortcut({
        id: "sc2",
        shortcutDetails: { targetId: "vid1", targetMimeType: "video/mp4" },
      }),
    ]);

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources).toEqual([]);
  });

  it("keeps the SHORTCUT's id, because that is what lives in the folder", async () => {
    // The target usually sits outside the corpus, often somewhere the parent
    // walk cannot see. Indexing its id would hand the scope check a file it
    // would rightly refuse.
    const http = drive([shortcut()], { doc1: { id: "doc1", version: "9" } });

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources[0].id).toBe("sc1");
    expect(page.resources[0].id).not.toBe("doc1");
  });

  it("takes the TARGET's version, so an edit is noticed", async () => {
    // A shortcut's own version never changes when its target is edited. A
    // corpus keyed on it would go stale with nothing to notice, because a
    // reconcile compares versions and this one always matches.
    const http = drive([shortcut({ version: "1" })], {
      doc1: { id: "doc1", version: "42", modifiedTime: "2026-09-26T00:00:00Z" },
    });

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources[0].version).toBe("42");
    expect(page.resources[0].updatedAt).toBe("2026-09-26T00:00:00Z");
  });

  it("reads the target's content, not the shortcut's", async () => {
    const http = drive([shortcut()], {
      sc1: shortcut(),
      doc1: { id: "doc1", mimeType: "text/plain", parents: ["ELSEWHERE"] },
    });

    const doc = await driver(http).fetch({ folderID: "F1" }, { service: "t" }, "sc1");

    expect(doc.markdown).toBe("target body");
  });

  it("keeps the resource when the target's metadata cannot be read", async () => {
    // Dropping it would make the shortcut silently never appear. Keeping it
    // means the fetch refuses later, with a reason.
    const http = vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(String(url)).searchParams.get("q") ?? "");
      if (q.includes("google-apps.folder")) return respond({ files: [] });
      if (q) return respond({ files: [shortcut({ version: "1" })] });
      return respond({}, 404);
    }) as unknown as FetchLike;

    const page = await driver(http).list({ folderID: "F1" }, { service: "t" }, undefined);

    expect(page.resources.map((r) => r.id)).toEqual(["sc1"]);
    expect(page.resources[0].version).toBe("1");
  });
});
