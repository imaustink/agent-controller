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
      { ...base, type: "opencode_event", event: { type: "message.part.updated", part: { text: "hi" } } },
      { ...base, type: "opencode_response", requestId: "req-1", status: 204 },
      { ...base, type: "opencode_response", requestId: "req-1", status: 200, body: { ok: true } },
      { ...base, type: "session_idle", liveUntil: "2026-07-13T00:20:00.000Z" },
      { ...base, type: "session_ended", reason: "idle timeout" },
      { ...base, type: "tool_call", callId: "call-1", tool: "kubectl-readonly", input: "get pods -n default" },
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
      { ...base, type: "opencode_request", requestId: "req-1", method: "POST", path: "/session/ses_1/prompt_async", body: { text: "continue" } },
      { ...base, type: "opencode_request", requestId: "req-2", method: "GET", path: "/session/ses_1/message" },
      { ...base, type: "tool_result", callId: "call-1", ok: true, result: { pods: [] } },
      { ...base, type: "tool_result", callId: "call-2", ok: false, error: "tool failed" },
    ]) {
      expect(AgentDownMessageSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects an unknown down type", () => {
    expect(AgentDownMessageSchema.safeParse({ ...base, type: "answer", answer: "x" }).success).toBe(false);
  });
});
