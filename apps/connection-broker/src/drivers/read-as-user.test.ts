import { describe, expect, it, vi } from "vitest";
import { ConfluenceDriver, type FetchLike } from "./confluence.js";
import { GDriveDriver } from "./gdrive.js";
import { SlackDriver } from "./slack.js";
import { PermissionDeniedError } from "./types.js";

function respond(body: unknown, status = 200, text?: string): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  };
}

/**
 * The read bounded by WHO IS ASKING rather than by the corpus's scope.
 *
 * Material cites other spaces, and an agent that can read a page but not the
 * page it references is not much use. What makes that safe is that the read
 * runs on the caller's own token: it grants no access they lack, it lets the
 * agent act with access they already have.
 */
describe("confluence readAsUser", () => {
  const page = {
    id: "12345",
    title: "Auth design",
    // A DIFFERENT space from any corpus under test. That is the point.
    spaceId: "99999",
    version: { number: 7 },
    _links: { webui: "/spaces/OTHER/pages/12345" },
    body: { storage: { value: "<p>hello</p>" } },
  };

  const driver = (http: FetchLike) =>
    new ConfluenceDriver({ siteBaseUrl: "https://wiki.test/wiki", cloudId: "c1", fetch: http });

  it("reads a page in ANOTHER space, which fetch would refuse", async () => {
    const http = vi.fn().mockResolvedValue(respond(page));

    const doc = await driver(http).readAsUser!({ delegated: "user" }, "12345");

    expect(doc.markdown).toBe("hello");
    expect(doc.title).toBe("Auth design");
  });

  it("refuses the SERVICE credential outright", async () => {
    // Falling back to it would turn "what may this person see" into "what may
    // the ingestion account see" — and that account is scoped to nothing, so
    // the fallback would be the widest read at the moment the narrowest was
    // intended.
    await expect(
      driver(vi.fn()).readAsUser!({ service: "svc" }, "12345"),
    ).rejects.toThrow(/delegated token/);
  });

  it("passes the caller's token, not the service one", async () => {
    const http = vi.fn().mockResolvedValue(respond(page));
    await driver(http).readAsUser!({ service: "svc", delegated: "user" }, "12345");

    expect(http).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer user" }) }),
    );
  });

  it("lets the SOURCE refuse a page this user cannot read", async () => {
    // Confluence answers 404 for a page outside this person's access, whatever
    // space it is in. That is the bound doing its job, not a failure.
    const http = vi.fn().mockResolvedValue(respond({}, 404));
    await expect(
      driver(http).readAsUser!({ delegated: "user" }, "12345"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("slack readAsUser", () => {
  const driver = (http: FetchLike) => new SlackDriver({ fetch: http, workspaceUrl: "https://w.slack.com" });

  it("reads a thread in another channel, addressed as <channel>/<ts>", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({ ok: true, messages: [{ ts: "1.1", user: "U1", text: "hello" }] }),
    );

    const doc = await driver(http).readAsUser!({ delegated: "xoxp" }, "COTHER/1.1");

    expect(doc.markdown).toContain("hello");
    expect(http.mock.calls[0]![0]).toContain("channel=COTHER");
  });

  it("refuses an id with no channel rather than guessing one", async () => {
    // A ts alone is ambiguous, and guessing against the corpus's own channel
    // would read a DIFFERENT thread that happens to share a timestamp.
    await expect(
      driver(vi.fn()).readAsUser!({ delegated: "xoxp" }, "1.1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("refuses the service credential", async () => {
    await expect(
      driver(vi.fn()).readAsUser!({ service: "xoxb" }, "C1/1.1"),
    ).rejects.toThrow(/delegated token/);
  });
});

describe("gdrive readAsUser", () => {
  const file = {
    id: "FILE1",
    name: "Notes",
    mimeType: "text/plain",
    // Outside any scoped folder — readable because the USER can read it.
    parents: ["SOMEONE_ELSES_FOLDER"],
    webViewLink: "https://drive.test/FILE1",
  };

  it("reads a file outside the scoped folder", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("alt=media") ? respond({}, 200, "contents") : respond(file),
    );

    const doc = await new GDriveDriver({ fetch: http as unknown as FetchLike }).readAsUser!(
      { delegated: "u" },
      "FILE1",
    );

    expect(doc.markdown).toBe("contents");
  });

  it("refuses the service credential", async () => {
    await expect(
      new GDriveDriver({ fetch: vi.fn() as unknown as FetchLike }).readAsUser!({ service: "s" }, "FILE1"),
    ).rejects.toThrow(/delegated token/);
  });
});

describe("the ingestion read is still scope-bounded", () => {
  it("fetch refuses a page outside the corpus, even with a delegated token", async () => {
    // The two reads must not converge: a sync pass has no user and runs on a
    // shared credential, so its bound has to stay the scope.
    const http = vi.fn(async (url: string) =>
      url.includes("/api/v2/spaces")
        ? respond({ results: [{ id: "77", key: "GLOBEX" }] })
        : respond({ id: "1", title: "t", spaceId: "99999" }),
    );
    const driver = new ConfluenceDriver({
      siteBaseUrl: "https://wiki.test/wiki",
      cloudId: "c1",
      fetch: http as unknown as FetchLike,
    });

    await expect(
      driver.fetch({ space: "GLOBEX" }, { delegated: "user" }, "1"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
