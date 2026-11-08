import { describe, expect, it } from "vitest";
import { TurnEventSchema, renderTurnEvent, approvalRequiredLine, type TurnEvent } from "./turn-event.js";

function ev(partial: Partial<TurnEvent> & Pick<TurnEvent, "kind">): TurnEvent {
  return { seq: 0, ts: "2026-10-05T00:00:00.000Z", ...partial };
}

describe("TurnEventSchema", () => {
  it("validates a minimal envelope", () => {
    const parsed = TurnEventSchema.safeParse({ seq: 3, ts: "2026-10-05T00:00:00.000Z", kind: "turn-started" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown kind and a negative seq", () => {
    expect(TurnEventSchema.safeParse({ seq: -1, ts: "t", kind: "warning" }).success).toBe(false);
    expect(TurnEventSchema.safeParse({ seq: 1, ts: "t", kind: "not-a-kind" }).success).toBe(false);
  });

  it("accepts the optional detail fields", () => {
    const parsed = TurnEventSchema.safeParse(
      ev({ kind: "tool-progress", toolId: "t", stage: "extract", pct: 50, message: "halfway", code: "x" }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("renderTurnEvent — reproduces the existing status strings", () => {
  it("renders the mechanical tool-lifecycle label exactly like progressListener", () => {
    // "<stage>: <message>" — the same label chat-completions.ts built inline.
    expect(renderTurnEvent(ev({ kind: "tool-progress", stage: "extract", message: "pulling page" }))).toBe(
      "extract: pulling page",
    );
    // No stage -> bare message.
    expect(renderTurnEvent(ev({ kind: "tool-started", message: "go" }))).toBe("go");
    // No message -> bare stage.
    expect(renderTurnEvent(ev({ kind: "warning", stage: "rate-limited" }))).toBe("rate-limited");
    // Neither -> the working placeholder.
    expect(renderTurnEvent(ev({ kind: "tool-finished" }))).toBe("working…");
  });

  it("clamps a long message to 120 chars, like the original label", () => {
    const long = "x".repeat(200);
    const out = renderTurnEvent(ev({ kind: "tool-progress", message: long }));
    expect(out).toBe("x".repeat(120));
  });

  it("renders skill-selected with the NODE_STATUS 'Selected skill: X.' wording", () => {
    expect(renderTurnEvent(ev({ kind: "skill-selected", message: "Recipe Publishing" }))).toBe(
      "Selected skill: Recipe Publishing.",
    );
  });

  it("renders approval-required with the exact shared ADR 0003 prompt", () => {
    expect(renderTurnEvent(ev({ kind: "approval-required", toolId: "github" }))).toBe(approvalRequiredLine("github"));
    expect(renderTurnEvent(ev({ kind: "approval-required", toolId: "github" }))).toBe(
      'Approval required: run tool "github"? Reply "approve" or "deny".',
    );
  });

  it("renders approval-resolved sensibly from the code field", () => {
    expect(renderTurnEvent(ev({ kind: "approval-resolved", toolId: "github", code: "approved" }))).toBe(
      'Approval approved: tool "github".',
    );
    expect(renderTurnEvent(ev({ kind: "approval-resolved", toolId: "github", code: "denied" }))).toBe(
      'Approval denied: tool "github".',
    );
  });

  it("renders the turn boundary kinds", () => {
    expect(renderTurnEvent(ev({ kind: "turn-started" }))).toBe("Starting…");
    expect(renderTurnEvent(ev({ kind: "turn-completed" }))).toBe("Done.");
  });
});
