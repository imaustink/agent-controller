import { describe, expect, it } from "vitest";
import { buildOpencodeConfig, buildPrompt, DENY_BASH_PATTERNS } from "./opencode.js";

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
