import { describe, expect, it, vi } from "vitest";
import { SlackDriver } from "./slack.js";
import { PermanentError, PermissionDeniedError, TransientError } from "./types.js";
import type { FetchLike } from "./confluence.js";

const SCOPE = { channel: "C123ABC" };

function respond(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const message = (ts: string, overrides: Record<string, unknown> = {}) => ({
  ts,
  text: "How do we rotate the signing key?",
  user: "U1",
  ...overrides,
});

const driver = (http: FetchLike) =>
  new SlackDriver({ fetch: http, workspaceUrl: "https://bitovi.slack.com" });

describe("scope validation", () => {
  const d = driver(vi.fn());

  it("requires a channel", () => {
    expect(() => d.validateScope({})).toThrow(/scoped to a channel/);
  });

  it("rejects a scope naming another provider's unit", () => {
    expect(() => d.validateScope({ channel: "C1", space: "SNC" })).toThrow(/nothing else/);
  });

  it("rejects a channel id that is not one", () => {
    // The id reaches a query parameter, so it is constrained, not trusted.
    expect(() => d.validateScope({ channel: "../../admin" })).toThrow(/illegal/);
  });
});

describe("probe granularity", () => {
  it("is per CONNECTION, because Slack authorizes the channel", () => {
    // Probing per message would issue one request per thread to ask a question
    // Slack answers once per channel.
    expect(driver(vi.fn()).probeGranularity()).toBe("connection");
  });
});

describe("list", () => {
  it("returns thread parents, not every message", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({
        ok: true,
        messages: [
          message("1700000001.0001"),
          // A reply: belongs to its thread, not to the index separately.
          message("1700000002.0002", { thread_ts: "1700000001.0001" }),
          message("1700000003.0003"),
        ],
      }),
    );

    const { resources } = await driver(http).list(SCOPE, { service: "xoxb" }, undefined);

    expect(resources.map((r) => r.id)).toEqual(["1700000001.0001", "1700000003.0003"]);
  });

  it("uses the message ts as the version", async () => {
    const http = vi.fn().mockResolvedValue(respond({ ok: true, messages: [message("1700000001.0001")] }));
    const { resources } = await driver(http).list(SCOPE, { service: "x" }, undefined);

    // Any edit produces a new ts on the message that changed.
    expect(resources[0]!.version).toBe("1700000001.0001");
  });

  it("marks membership-governed chunks permissive rather than guessing", async () => {
    const http = vi.fn().mockResolvedValue(respond({ ok: true, messages: [message("1.1")] }));
    const { resources } = await driver(http).list(SCOPE, { service: "x" }, undefined);

    expect(resources[0]!.acl).toEqual({ principals: [], permissive: true });
  });

  it("ends the walk when Slack reports no more", async () => {
    const http = vi.fn().mockResolvedValue(respond({ ok: true, messages: [message("1.1")], has_more: false }));
    const { cursor } = await driver(http).list(SCOPE, { service: "x" }, undefined);
    expect(cursor).toBeUndefined();
  });
});

describe("fetch", () => {
  it("returns the WHOLE thread as one document", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({
        ok: true,
        messages: [
          message("1.1", { text: "How do we rotate the signing key?" }),
          message("1.2", { user: "U2", text: "Run the rotate script, then restart." }),
        ],
      }),
    );

    const doc = await driver(http).fetch(SCOPE, { service: "x" }, "1.1");

    // A question and its answer belong together; splitting them is what makes
    // a chat corpus useless.
    expect(doc.markdown).toContain("How do we rotate the signing key?");
    expect(doc.markdown).toContain("Run the rotate script");
  });

  it("prefers the delegated token when a user is reading", async () => {
    const http = vi.fn().mockResolvedValue(respond({ ok: true, messages: [message("1.1")] }));
    await driver(http).fetch(SCOPE, { service: "svc", delegated: "user" }, "1.1");

    expect(http.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer user" }) }),
    );
  });
});

describe("probe", () => {
  it("asks about the channel and needs no message id", async () => {
    const http = vi.fn().mockResolvedValue(respond({ ok: true, channel: { name: "snc-eng" } }));

    const result = await driver(http).probe(SCOPE, { delegated: "xoxp" });

    expect(result).toEqual({
      allowed: true,
      title: "#snc-eng",
      url: "https://bitovi.slack.com/archives/C123ABC",
      version: undefined,
    });
  });

  it("refuses to probe without a delegated token", async () => {
    await expect(driver(vi.fn()).probe(SCOPE, { service: "svc" })).rejects.toThrow(/delegated token/);
  });
});

describe("error classification", () => {
  it("treats a 200 with ok:false as the real answer", async () => {
    // Slack answers 200 for most failures, so the HTTP status is not the answer.
    const http = vi.fn().mockResolvedValue(respond({ ok: false, error: "channel_not_found" }));
    await expect(driver(http).probe(SCOPE, { delegated: "u" })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it.each(["not_in_channel", "is_archived", "thread_not_found"])(
    "treats %s as a denial",
    async (error) => {
      const http = vi.fn().mockResolvedValue(respond({ ok: false, error }));
      await expect(driver(http).probe(SCOPE, { delegated: "u" })).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    },
  );

  it.each(["invalid_auth", "token_revoked", "missing_scope"])(
    "treats %s as permanent, not transient",
    async (error) => {
      // Retrying cannot help: the token or app is wrong, not busy.
      const http = vi.fn().mockResolvedValue(respond({ ok: false, error }));
      await expect(driver(http).probe(SCOPE, { delegated: "u" })).rejects.toBeInstanceOf(PermanentError);
    },
  );

  it("treats rate limiting as transient", async () => {
    const http = vi.fn().mockResolvedValue(respond({}, 429));
    await expect(driver(http).probe(SCOPE, { delegated: "u" })).rejects.toBeInstanceOf(TransientError);
  });

  it("treats an unrecognised slack error as transient, not a denial", async () => {
    // Counting an unknown failure as a denial would silently shrink an answer.
    const http = vi.fn().mockResolvedValue(respond({ ok: false, error: "something_new" }));
    await expect(driver(http).probe(SCOPE, { delegated: "u" })).rejects.toBeInstanceOf(TransientError);
  });
});
