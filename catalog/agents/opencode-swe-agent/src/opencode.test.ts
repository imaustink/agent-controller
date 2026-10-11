import { describe, expect, it } from "vitest";
import {
  buildOpencodeConfig,
  buildPrompt,
  DENY_BASH_PATTERNS,
  isReviewMode,
  REVIEW_DENY_BASH_PATTERNS,
  REVIEW_MODE_MARKER,
} from "./opencode.js";

describe("buildOpencodeConfig", () => {
  it("pins the model and bakes in bash deny rules alongside a blanket allow", () => {
    const config = buildOpencodeConfig({ model: "anthropic/claude-sonnet-5" }) as {
      model: string;
      permission: Record<string, unknown>;
    };
    expect(config.model).toBe("anthropic/claude-sonnet-5");
    expect(config.permission.edit).toBe("allow");
    expect(config.permission.webfetch).toBe("allow");
    const bash = config.permission.bash as Record<string, string>;
    expect(bash["*"]).toBe("allow");
    for (const pattern of DENY_BASH_PATTERNS) {
      expect(bash[pattern]).toBe("deny");
    }
  });

  // FIX 1: a review run is code-enforced read-only via opencode's own bash deny
  // globs. Without the reviewMode branch these are absent and a review could push.
  it("denies git push / gh pr create / gh pr merge when reviewMode is set", () => {
    const config = buildOpencodeConfig({ model: "anthropic/claude-sonnet-5", reviewMode: true }) as {
      permission: { bash: Record<string, string> };
    };
    const bash = config.permission.bash;
    expect(bash["git push*"]).toBe("deny");
    expect(bash["gh pr create*"]).toBe("deny");
    expect(bash["gh pr merge*"]).toBe("deny");
    for (const pattern of REVIEW_DENY_BASH_PATTERNS) expect(bash[pattern]).toBe("deny");
  });

  it("omits the review denies on a change run (push/PR-create stay allowed)", () => {
    const config = buildOpencodeConfig({ model: "anthropic/claude-sonnet-5" }) as {
      permission: { bash: Record<string, string> };
    };
    expect(config.permission.bash["git push*"]).toBeUndefined();
    expect(config.permission.bash["gh pr create*"]).toBeUndefined();
  });
});

describe("isReviewMode", () => {
  it("detects the exact sentinel a review IntegrationRoute injects", () => {
    expect(isReviewMode(`${REVIEW_MODE_MARKER}\nPull request acme/widgets#7 ...`)).toBe(true);
  });

  it("is false for an ordinary change/triage goal", () => {
    expect(isReviewMode("Pick this pull request back up and get it ready to merge.")).toBe(false);
  });

  it("uses the same marker string as claude-code-swe-agent and the chart templates", () => {
    expect(REVIEW_MODE_MARKER).toBe("SWE-ENFORCED-MODE: review-only");
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
});
