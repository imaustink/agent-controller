import { describe, expect, it, vi } from "vitest";
import { ConfluenceDriver } from "./confluence.js";
import { GDriveDriver } from "./gdrive.js";
import { SlackDriver } from "./slack.js";
import { matchPath } from "./path-allowlist.js";
import { PermissionDeniedError, type FetchLike } from "./types.js";

function respond(body: unknown, status = 200, text?: string): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  };
}

/**
 * The GET face takes a path from a MODEL. A provider API is far larger than
 * the part a knowledge base needs, so without an allowlist this is a general
 * proxy onto a client's credential rather than a live view of indexed
 * material.
 */
describe("matchPath", () => {
  const patterns = [/^pages\/(\d+)$/, /^pages\/(\d+)\/children$/];

  it("returns the captured id, not the path", () => {
    // Nothing downstream should be handed a string the allowlist did not
    // itself vouch for.
    expect(matchPath("pages/12345", patterns)).toBe("12345");
  });

  it("tolerates leading and trailing slashes", () => {
    expect(matchPath("/pages/12345/", patterns)).toBe("12345");
  });

  it("refuses traversal", () => {
    expect(matchPath("pages/../../admin", patterns)).toBeUndefined();
    expect(matchPath("pages//12345", patterns)).toBeUndefined();
  });

  it("refuses anything the patterns do not anchor", () => {
    expect(matchPath("pages/12345/restrictions", patterns)).toBeUndefined();
    expect(matchPath("spaces/SECRET", patterns)).toBeUndefined();
    expect(matchPath("https://evil.test/pages/1", patterns)).toBeUndefined();
  });
});

describe("confluence GET face", () => {
  const scope = { space: "GLOBEX" };
  const page = { id: "12345", title: "Auth", spaceId: "77", _links: { webui: "/x/1" } };

  const driver = (http: FetchLike) =>
    new ConfluenceDriver({ siteBaseUrl: "https://wiki.test/wiki", cloudId: "c1", fetch: http });

  const routed = (overrides: (url: string) => unknown = () => page): FetchLike =>
    (async (url: string) => {
      if (url.includes("/api/v2/spaces")) return respond({ results: [{ id: "77", key: "GLOBEX" }] });
      return respond(overrides(url));
    }) as unknown as FetchLike;

  it("reads a page inside the scope", async () => {
    const result = await driver(routed()).api!(scope, { delegated: "user" }, { path: "pages/12345" });

    expect(result.url).toBe("https://wiki.test/wiki/x/1");
    expect(result.body).toMatchObject({ id: "12345" });
  });

  it("refuses a path the allowlist does not serve", async () => {
    // A provider API is much larger than the two reads a knowledge base needs.
    await expect(
      driver(routed()).api!(scope, { delegated: "user" }, { path: "spaces/OTHER/pages" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("refuses a page outside the corpus scope", async () => {
    // Same boundary fetch enforces: a page id alone must not reach another
    // client's space, however it was obtained.
    const elsewhere = routed(() => ({ ...page, spaceId: "99999" }));
    await expect(
      driver(elsewhere).api!(scope, { delegated: "user" }, { path: "pages/12345" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("refuses to read on the INGESTION credential", async () => {
    // It would answer "what can the service account see", which is not the
    // question the caller asked (ADR 0040).
    await expect(
      driver(routed()).api!(scope, { service: "svc" }, { path: "pages/12345" }),
    ).rejects.toThrow(/delegated token/);
  });
});

describe("slack GET face", () => {
  const scope = { channel: "C123ABC" };
  const driver = (http: FetchLike) => new SlackDriver({ fetch: http, workspaceUrl: "https://w.slack.com" });

  it("re-reads a thread and renders its markup", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({ ok: true, messages: [{ ts: "1.1", user: "U1", text: "see <https://x.test|it>" }] }),
    );

    const result = await driver(http).api!(scope, { delegated: "u" }, { path: "threads/1.1" });

    expect(result.body).toMatchObject({
      messages: [{ ts: "1.1", text: "see [it](https://x.test)" }],
    });
  });

  it("refuses anything but a thread", async () => {
    await expect(
      driver(vi.fn()).api!(scope, { delegated: "u" }, { path: "conversations.list" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("does not auto-join on a USER read", async () => {
    // autoJoin exists for ingestion. A user who cannot see the channel gets a
    // denial, which is the answer rather than a problem to work around.
    const http = vi.fn().mockResolvedValue(respond({ ok: false, error: "not_in_channel" }));
    const joining = new SlackDriver({ fetch: http, autoJoin: true, workspaceUrl: "https://w.slack.com" });

    await expect(
      joining.api!(scope, { delegated: "u" }, { path: "threads/1.1" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(http.mock.calls.some(([url]) => (url as string).includes("conversations.join"))).toBe(false);
  });
});

describe("gdrive GET face", () => {
  const scope = { folderID: "FOLDER1" };
  const file = {
    id: "FILE1",
    name: "Notes",
    mimeType: "text/plain",
    parents: ["FOLDER1"],
    webViewLink: "https://drive.test/FILE1",
  };

  it("reads a file inside the folder", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("alt=media") ? respond({}, 200, "file contents") : respond(file),
    );
    const driver = new GDriveDriver({ fetch: http as unknown as FetchLike });

    const result = await driver.api!(scope, { delegated: "u" }, { path: "files/FILE1" });
    expect(result.body).toMatchObject({ markdown: "file contents" });
  });

  it("refuses a file outside the folder", async () => {
    const http = vi.fn().mockResolvedValue(respond({ ...file, parents: ["SOMEONE_ELSE"] }));
    const driver = new GDriveDriver({ fetch: http as unknown as FetchLike });

    await expect(
      driver.api!(scope, { delegated: "u" }, { path: "files/FILE1" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("refuses a path the allowlist does not serve", async () => {
    const driver = new GDriveDriver({ fetch: vi.fn() as unknown as FetchLike });
    await expect(
      driver.api!(scope, { delegated: "u" }, { path: "drives" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
