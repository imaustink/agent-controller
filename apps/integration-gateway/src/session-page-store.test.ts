import { describe, expect, it } from "vitest";
import { InMemorySessionPageStore } from "./session-page-store.js";

describe("InMemorySessionPageStore", () => {
  it("creates one entry per session id and reuses it on subsequent calls", async () => {
    const store = new InMemorySessionPageStore();
    const first = await store.getOrCreate("github:acme/widgets#1", { owner: "acme", repo: "widgets", issueNumber: 1 });
    const second = await store.getOrCreate("github:acme/widgets#1", { owner: "acme", repo: "widgets", issueNumber: 1 });
    expect(second.token).toBe(first.token);
  });

  it("looks entries up by token", async () => {
    const store = new InMemorySessionPageStore();
    const entry = await store.getOrCreate("github:acme/widgets#1", { owner: "acme", repo: "widgets", issueNumber: 1 });
    await expect(store.getByToken(entry.token)).resolves.toEqual(entry);
    await expect(store.getByToken("nope")).resolves.toBeUndefined();
  });

  it("does not create an entry when adding a turn for an unknown session id", async () => {
    const store = new InMemorySessionPageStore();
    await expect(store.addTurn("github:acme/widgets#404", "hello")).resolves.toBeUndefined();
    await expect(store.getByToken("anything")).resolves.toBeUndefined();
  });

  it("appends and completes turns in order", async () => {
    const store = new InMemorySessionPageStore();
    const entry = await store.getOrCreate("github:acme/widgets#1", { owner: "acme", repo: "widgets", issueNumber: 1 });
    const added = await store.addTurn(entry.sessionId, "do the thing");
    expect(added).toBeDefined();
    expect(entry.turns[added!.turnIndex]).toMatchObject({ request: "do the thing", status: "pending" });

    await store.completeTurn(entry.sessionId, added!.turnIndex, { status: "succeeded", result: "done" });
    expect(entry.turns[added!.turnIndex]).toMatchObject({ status: "succeeded", result: "done" });
  });

  it("completing an out-of-range turn index is a no-op", async () => {
    const store = new InMemorySessionPageStore();
    const entry = await store.getOrCreate("github:acme/widgets#1", { owner: "acme", repo: "widgets", issueNumber: 1 });
    await expect(store.completeTurn(entry.sessionId, 5, { status: "succeeded", result: "done" })).resolves.toBeUndefined();
  });

  it("sets and clears cached live-tunnel info (ADR 0026)", async () => {
    const store = new InMemorySessionPageStore();
    const entry = await store.getOrCreate("github:acme/widgets#1", { owner: "acme", repo: "widgets", issueNumber: 1 });

    await store.setLive(entry.sessionId, { agentRunId: "run-42" });
    expect((await store.getByToken(entry.token))?.live).toEqual({ agentRunId: "run-42" });

    await store.setLive(entry.sessionId, { agentRunId: "run-42", opencodeSessionId: "ses_abc123" });
    expect((await store.getByToken(entry.token))?.live).toEqual({ agentRunId: "run-42", opencodeSessionId: "ses_abc123" });

    await store.setLive(entry.sessionId, undefined);
    expect((await store.getByToken(entry.token))?.live).toBeUndefined();
  });

  it("setLive on an unknown session id is a no-op", async () => {
    const store = new InMemorySessionPageStore();
    await expect(store.setLive("github:acme/widgets#404", { agentRunId: "run-1" })).resolves.toBeUndefined();
  });
});
