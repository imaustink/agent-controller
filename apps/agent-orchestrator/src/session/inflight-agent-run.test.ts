import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "./in-memory-session-store.js";
import { clearAgentRunAwaitingReply, markAgentRunAwaitingReply } from "./inflight-agent-run.js";

function store(): InMemorySessionStore {
  return new InMemorySessionStore({ ttlMs: 60_000, maxEntries: 10 });
}

describe("markAgentRunAwaitingReply", () => {
  it("writes the anchor for a conversation with no record yet", async () => {
    const s = store();

    await markAgentRunAwaitingReply(s, "session-1", { subject: "alice", agentId: "swe", agentRunId: "run-1" });

    expect(await s.get("session-1")).toMatchObject({
      subject: "alice",
      activeAgentId: "swe",
      activeAgentRunId: "run-1",
      activeAgentRunAwaitingReply: true,
      lastAgentRunId: "run-1",
    });
  });

  /**
   * `SessionStore.set` replaces the whole record, so the read-modify-write is
   * load-bearing: buying resumability by dropping a conversation's continuation
   * tokens would trade one broken follow-up turn for another.
   */
  it("preserves everything else already stored for the conversation", async () => {
    const s = store();
    await s.set("session-1", {
      subject: "alice",
      toolContinuations: { "recipe-publisher": "slug-42" },
      agentContinuations: { swe: "branch-token" },
    });

    await markAgentRunAwaitingReply(s, "session-1", { subject: "alice", agentId: "swe", agentRunId: "run-1" });

    expect(await s.get("session-1")).toMatchObject({
      toolContinuations: { "recipe-publisher": "slug-42" },
      agentContinuations: { swe: "branch-token" },
      activeAgentRunId: "run-1",
    });
  });

  it("keeps the stored subject rather than overwriting it", async () => {
    const s = store();
    await s.set("session-1", { subject: "alice" });

    await markAgentRunAwaitingReply(s, "session-1", { subject: "bob", agentId: "swe", agentRunId: "run-1" });

    // A conversation belongs to the subject it was created under (ADR 0012);
    // this helper records a run, it does not re-own the session.
    expect((await s.get("session-1"))?.subject).toBe("alice");
  });

  it("clears any active skill, since a turn continues a skill or a run, never both", async () => {
    const s = store();
    await s.set("session-1", { subject: "alice", activeSkillId: "publish-recipe" });

    await markAgentRunAwaitingReply(s, "session-1", { subject: "alice", agentId: "swe", agentRunId: "run-1" });

    expect((await s.get("session-1"))?.activeSkillId).toBeUndefined();
  });
});

describe("clearAgentRunAwaitingReply", () => {
  it("drops the anchor but keeps continuations", async () => {
    const s = store();
    await s.set("session-1", {
      subject: "alice",
      activeAgentId: "swe",
      activeAgentRunId: "run-1",
      activeAgentRunAwaitingReply: true,
      agentContinuations: { swe: "branch-token" },
      lastAgentRunId: "run-1",
    });

    await clearAgentRunAwaitingReply(s, "session-1");

    const record = await s.get("session-1");
    expect(record?.activeAgentRunId).toBeUndefined();
    expect(record?.activeAgentId).toBeUndefined();
    expect(record?.activeAgentRunAwaitingReply).toBeUndefined();
    expect(record?.agentContinuations).toEqual({ swe: "branch-token" });
    // Kept deliberately (ADR 0026): a live-session viewer still needs a run id
    // to probe, even one that has concluded.
    expect(record?.lastAgentRunId).toBe("run-1");
  });

  it("is a no-op for a conversation with no record", async () => {
    const s = store();
    await clearAgentRunAwaitingReply(s, "session-nope");
    expect(await s.get("session-nope")).toBeUndefined();
  });
});
