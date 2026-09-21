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
