import { describe, expect, it } from "vitest";
import {
  AgentUpMessageSchema,
  AgentDownMessageSchema,
  agentSubjects,
} from "./agent-protocol.js";

describe("agentSubjects", () => {
  it("derives deterministic up/down subjects keyed by agent run id", () => {
    expect(agentSubjects("run-123")).toEqual({
      up: "agent.run-123.up",
      down: "agent.run-123.down",
    });
  });

  it("honors a custom prefix", () => {
    expect(agentSubjects("run-123", "ca")).toEqual({
      up: "ca.run-123.up",
      down: "ca.run-123.down",
    });
  });
});

describe("AgentUpMessageSchema", () => {
  const base = { agent_run_id: "run-1", seq: 0, ts: "2026-07-13T00:00:00.000Z" };

  it("accepts each up message type", () => {
    for (const msg of [
      { ...base, type: "ready" },
      { ...base, type: "progress", message: "cloning repo", pct: 10 },
      { ...base, type: "warning", message: "rate limited, retrying" },
      { ...base, type: "reply", message: "Which branch?", final: false },
      { ...base, type: "reply", message: "Opened PR #1", final: true, result: { pr: 1 } },
      { ...base, type: "failed", code: "clone_failed", message: "no such repo" },
    ]) {
      expect(AgentUpMessageSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects an unknown type and a reply missing final", () => {
    expect(AgentUpMessageSchema.safeParse({ ...base, type: "bogus" }).success).toBe(false);
    expect(AgentUpMessageSchema.safeParse({ ...base, type: "reply", message: "no final" }).success).toBe(false);
  });
});

describe("AgentDownMessageSchema", () => {
  const base = { agent_run_id: "run-1", seq: 0, ts: "2026-07-13T00:00:00.000Z" };

  it("accepts each down message type", () => {
    for (const msg of [
      { ...base, type: "prompt", message: "add a health check endpoint" },
      { ...base, type: "cancel", reason: "user left" },
      { ...base, type: "signal", name: "pause" },
    ]) {
      expect(AgentDownMessageSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects an unknown down type", () => {
    expect(AgentDownMessageSchema.safeParse({ ...base, type: "answer", answer: "x" }).success).toBe(false);
  });
});
