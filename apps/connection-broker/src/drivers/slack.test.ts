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

describe("auto join", () => {
  const joining = (http: FetchLike) =>
    new SlackDriver({ fetch: http, workspaceUrl: "https://bitovi.slack.com", autoJoin: true });

  /** Refuses the first read for want of membership, then succeeds. */
  function refuseThenAllow() {
    let joined = false;
    const calls: string[] = [];
    const http = vi.fn(async (url: string) => {
      calls.push(new URL(url).pathname.split("/").pop()!);
      if (url.includes("conversations.join")) {
        joined = true;
        return respond({ ok: true, channel: { id: "C123ABC" } });
      }
      if (!joined) return respond({ ok: false, error: "not_in_channel" });
      return respond({ ok: true, messages: [message("1.1")] });
    });
    return { http: http as unknown as FetchLike, calls };
  }

  it("joins and retries when a read is refused for want of membership", async () => {
    const { http, calls } = refuseThenAllow();

    const { resources } = await joining(http).list(SCOPE, { service: "xoxb" }, undefined);

    expect(resources).toHaveLength(1);
    expect(calls).toEqual(["conversations.history", "conversations.join", "conversations.history"]);
  });

  it("does not join when the read already works", async () => {
    const http = vi.fn().mockResolvedValue(respond({ ok: true, messages: [message("1.1")] }));
    await joining(http).list(SCOPE, { service: "xoxb" }, undefined);

    // Lazy on purpose: the ordinary path stays read-only, so a connection whose
    // channel we are already in never writes anything.
    expect(http.mock.calls.some(([url]) => (url as string).includes("conversations.join"))).toBe(false);
  });

  it("does not join at all when the Connection did not ask for it", async () => {
    const { http, calls } = refuseThenAllow();

    await expect(driver(http).list(SCOPE, { service: "xoxb" }, undefined)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(calls).toEqual(["conversations.history"]);
  });

  it("retries exactly once, then gives up", async () => {
    // Still refused after a successful join: the refusal is about something
    // else, and repeating would spin against Slack with a credential that is
    // not going to start working.
    const http = vi.fn(async (url: string) =>
      url.includes("conversations.join")
        ? respond({ ok: true })
        : respond({ ok: false, error: "not_in_channel" }),
    );

    await expect(
      joining(http as unknown as FetchLike).list(SCOPE, { service: "xoxb" }, undefined),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(http.mock.calls.filter(([url]) => (url as string).includes("conversations.join"))).toHaveLength(1);
  });

  it("never joins on a PROBE, whatever the Connection says", async () => {
    const http = vi.fn(async (url: string) =>
      url.includes("conversations.join")
        ? respond({ ok: true })
        : respond({ ok: false, error: "not_in_channel" }),
    );

    // A probe asks whether a USER may read something. Joining on their behalf
    // changes the answer rather than reporting it, adds them to a channel they
    // never asked to join, and announces it to everyone in it.
    await expect(
      joining(http as unknown as FetchLike).probe(SCOPE, { delegated: "xoxp" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(http.mock.calls.some(([url]) => (url as string).includes("conversations.join"))).toBe(false);
  });

  it("does not try to join a channel it cannot see", async () => {
    // channel_not_found covers both "does not exist" and "private, invisible to
    // us". Joining either is a request that cannot succeed.
    const http = vi.fn().mockResolvedValue(respond({ ok: false, error: "channel_not_found" }));

    await expect(
      joining(http).list(SCOPE, { service: "xoxb" }, undefined),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(http.mock.calls.some(([url]) => (url as string).includes("conversations.join"))).toBe(false);
  });

  it("joins only the channel in scope", async () => {
    const { http, calls } = refuseThenAllow();
    await joining(http).list(SCOPE, { service: "xoxb" }, undefined);
    void calls;

    // The id comes from the Connection CR, never from a caller, so this cannot
    // be steered into joining anything else.
    const joinCall = (http as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      (url as string).includes("conversations.join"),
    );
    expect(new URL(joinCall![0] as string).searchParams.get("channel")).toBe("C123ABC");
  });
});


describe("system messages", () => {
  /** What conversations.history actually returns for a join. */
  const joined = (ts: string) =>
    message(ts, { subtype: "channel_join", text: "<@U1> has joined the channel" });

  it("does not index a join as a document", async () => {
    // Found against a real channel: this was the FIRST indexed document,
    // because a join event is a message like any other to Slack. A busy
    // channel is mostly these.
    const http = vi.fn().mockResolvedValue(
      respond({ ok: true, messages: [joined("1.1"), message("2.2")] }),
    );

    const { resources } = await driver(http).list(SCOPE, { service: "x" }, undefined);

    expect(resources.map((r) => r.id)).toEqual(["2.2"]);
  });

  it.each(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name"])(
    "drops %s",
    async (subtype) => {
      const http = vi.fn().mockResolvedValue(
        respond({ ok: true, messages: [message("1.1", { subtype, text: "something" })] }),
      );
      const { resources } = await driver(http).list(SCOPE, { service: "x" }, undefined);
      expect(resources).toEqual([]);
    },
  );

  it("KEEPS a bot message, which is real content", async () => {
    // A bot posting a deploy summary or an alert is often exactly what
    // somebody later searches for.
    const http = vi.fn().mockResolvedValue(
      respond({
        ok: true,
        messages: [message("1.1", { subtype: "bot_message", text: "Deploy 4.2 finished" })],
      }),
    );

    const { resources } = await driver(http).list(SCOPE, { service: "x" }, undefined);
    expect(resources).toHaveLength(1);
  });

  it("drops a message with no text, which would embed as an empty chunk", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({ ok: true, messages: [message("1.1", { text: "   " }), message("2.2")] }),
    );
    const { resources } = await driver(http).list(SCOPE, { service: "x" }, undefined);
    expect(resources.map((r) => r.id)).toEqual(["2.2"]);
  });

  it("tests for the PRESENCE of a subtype rather than denylisting known ones", async () => {
    // A denylist silently starts indexing whatever subtype Slack adds next.
    const http = vi.fn().mockResolvedValue(
      respond({ ok: true, messages: [message("1.1", { subtype: "some_future_subtype" })] }),
    );
    const { resources } = await driver(http).list(SCOPE, { service: "x" }, undefined);
    expect(resources).toEqual([]);
  });

  it("strips system messages out of a thread body but keeps its parent", async () => {
    const http = vi.fn().mockResolvedValue(
      respond({
        ok: true,
        messages: [
          message("1.1", { text: "How do we rotate the key?" }),
          joined("1.2"),
          message("1.3", { user: "U2", text: "Run the rotate script." }),
        ],
      }),
    );

    const doc = await driver(http).fetch(SCOPE, { service: "x" }, "1.1");

    expect(doc.markdown).toContain("How do we rotate the key?");
    expect(doc.markdown).toContain("Run the rotate script.");
    expect(doc.markdown).not.toContain("has joined the channel");
  });

  it("keeps the parent even when it is itself a system message", async () => {
    // Dropping it would leave a thread with no opening. Listing already
    // prevents such a thread from being indexed at all; this is about not
    // producing a headless document if one is fetched directly.
    const http = vi.fn().mockResolvedValue(respond({ ok: true, messages: [joined("1.1")] }));

    const doc = await driver(http).fetch(SCOPE, { service: "x" }, "1.1");
    expect(doc.markdown).toContain("has joined the channel");
  });
});
