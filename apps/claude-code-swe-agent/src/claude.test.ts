import { describe, expect, it } from "vitest";
import { buildClaudeSettings, buildPrompt, DENY_BASH_PATTERNS } from "./claude.js";

describe("buildClaudeSettings", () => {
  it("bypasses permissions and bakes in the bash deny rules", () => {
    const settings = buildClaudeSettings() as {
      permissions: { defaultMode: string; deny: string[] };
    };
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    expect(settings.permissions.deny).toEqual(DENY_BASH_PATTERNS);
  });
});

describe("buildPrompt", () => {
  it("includes continuation context when a marker is present", () => {
    const prompt = buildPrompt("add a health check", {
      repo: "acme/widgets",
      branch: "feature/health-check",
      pr: "12",
      session: "ses_abc123",
    });
    expect(prompt).toContain("CONTINUING work on an existing pull request");
    expect(prompt).toContain("acme/widgets");
    expect(prompt).toContain("feature/health-check");
    expect(prompt).toContain("#12");
  });

  it("omits continuation context with no marker", () => {
    const prompt = buildPrompt("add a health check", null);
    expect(prompt).not.toContain("CONTINUING work");
    expect(prompt).toContain("gh repo create");
  });

  it("embeds the caller instruction as data under the Task heading", () => {
    const prompt = buildPrompt("add a health check", null);
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("add a health check");
  });

  // Guards the fix for issue #185 ("Claude Agent is Too Eager"): the fixed
  // policy must tell the headless agent to stay in scope and to STOP and
  // surface a blocker rather than improvise a workaround when it is blocked
  // or unsure. These are trusted policy, so they must be present regardless
  // of the caller instruction or whether this is a continuation turn.
  describe("scope-discipline guardrails (issue #185)", () => {
    for (const marker of [
      null,
      { repo: "acme/widgets", branch: "feature/x", pr: "9", session: "ses_1" },
    ] as const) {
      const label = marker ? "on a continuation turn" : "on a fresh turn";

      it(`tells the agent to stay within the task scope ${label}`, () => {
        const prompt = buildPrompt("do the thing", marker);
        expect(prompt).toContain("Stay within the scope of the task as given");
      });

      it(`tells the agent to STOP rather than improvise when blocked or unsure ${label}`, () => {
        const prompt = buildPrompt("do the thing", marker);
        expect(prompt).toContain("When you are blocked or unsure, STOP rather than improvising");
      });

      it(`forbids substituting or creating a repository to work around a block ${label}`, () => {
        const prompt = buildPrompt("do the thing", marker);
        expect(prompt).toContain("Do NOT substitute a different repository");
        expect(prompt).toContain("create a new repository the task didn't call for");
      });

      it(`tells the agent to surface the blocker for a human ${label}`, () => {
        const prompt = buildPrompt("do the thing", marker);
        expect(prompt).toContain("surface the blocker");
        expect(prompt).toContain("so a human can decide and re-trigger you");
      });
    }
  });
});
