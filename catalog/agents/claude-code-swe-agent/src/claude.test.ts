import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClaudeSettings,
  buildPrompt,
  DENY_BASH_PATTERNS,
  isReviewMode,
  REVIEW_DENY_BASH_PATTERNS,
  REVIEW_MODE_MARKER,
} from "./claude.js";

describe("buildClaudeSettings", () => {
  it("bypasses permissions and bakes in the bash deny rules", () => {
    const settings = buildClaudeSettings() as {
      permissions: { defaultMode: string; deny: string[] };
    };
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
    expect(settings.permissions.deny).toEqual(DENY_BASH_PATTERNS);
  });

  // FIX 1: a review run is CODE-ENFORCED read-only -- the deny list, not the
  // prompt, is what stops a push/PR. Without the reviewMode branch these
  // assertions fail (buildClaudeSettings used to ignore its argument).
  describe("review mode (read-only enforcement)", () => {
    const denyOf = (reviewMode: boolean): string[] =>
      (buildClaudeSettings(reviewMode) as { permissions: { deny: string[] } }).permissions.deny;

    it("denies git push, gh pr create, and gh pr merge on a review run", () => {
      const deny = denyOf(true);
      expect(deny).toContain("Bash(git push:*)");
      expect(deny).toContain("Bash(gh pr create:*)");
      expect(deny).toContain("Bash(gh pr merge:*)");
      // and keeps every baseline guardrail
      for (const pattern of DENY_BASH_PATTERNS) expect(deny).toContain(pattern);
      for (const pattern of REVIEW_DENY_BASH_PATTERNS) expect(deny).toContain(pattern);
    });

    it("does NOT add the review denies on a change run (push/PR-create stay allowed)", () => {
      const deny = denyOf(false);
      expect(deny).not.toContain("Bash(git push:*)");
      expect(deny).not.toContain("Bash(gh pr create:*)");
      expect(deny).not.toContain("Bash(gh pr merge:*)");
      expect(deny).toEqual(DENY_BASH_PATTERNS);
    });
  });
});

describe("isReviewMode", () => {
  it("detects the exact sentinel a review IntegrationRoute injects into the goal", () => {
    const goal = `${REVIEW_MODE_MARKER}\nPull request acme/widgets#7 was labeled "ai-review": "Add health check"\n\nReview this pull request.`;
    expect(isReviewMode(goal)).toBe(true);
  });

  it("is false for an ordinary change/triage goal", () => {
    expect(isReviewMode("Pick this pull request back up and get it ready to merge.")).toBe(false);
  });

  it("keeps the marker constant byte-for-byte identical to what the review chart templates emit", () => {
    expect(REVIEW_MODE_MARKER).toBe("SWE-ENFORCED-MODE: review-only");
    // Guard against the agent's marker and the chart's sentinel drifting apart
    // -- the only per-route signal that reaches this container is this string.
    const templatesDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../orchestrator/charts/community-components/templates",
    );
    for (const file of [
      "integrationroute-github-pr-labeled-review.yaml",
      "integrationroute-github-issue-labeled-review.yaml",
    ]) {
      const yaml = readFileSync(join(templatesDir, file), "utf8");
      expect(yaml, `${file} must emit the review sentinel`).toContain(REVIEW_MODE_MARKER);
    }
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

  it("puts an invoked skill at the very start, where the CLI expands it", () => {
    const prompt = buildPrompt("the spec in #42", null, "implement");
    expect(prompt.startsWith("/implement You are an autonomous")).toBe(true);
    expect(prompt).toContain("## Task\nthe spec in #42");
    expect(buildPrompt("the spec in #42", null)).toBe(prompt.slice("/implement ".length));
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
