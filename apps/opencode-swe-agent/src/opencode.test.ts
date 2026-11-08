import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOpencodeConfig,
  buildPrompt,
  DENY_BASH_PATTERNS,
  isReadOnly,
  READ_ONLY_DENY_BASH_PATTERNS,
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

  // FIX 1: a read-only run is code-enforced via opencode's own bash deny
  // globs. Without the readOnly branch these are absent and a review could push.
  it("denies git push / gh pr create / gh pr merge when readOnly is set", () => {
    const config = buildOpencodeConfig({ model: "anthropic/claude-sonnet-5", readOnly: true }) as {
      permission: { bash: Record<string, string> };
    };
    const bash = config.permission.bash;
    expect(bash["git push*"]).toBe("deny");
    expect(bash["gh pr create*"]).toBe("deny");
    expect(bash["gh pr merge*"]).toBe("deny");
    for (const pattern of READ_ONLY_DENY_BASH_PATTERNS) expect(bash[pattern]).toBe("deny");
  });

  it("omits the read-only denies on a change run (push/PR-create stay allowed)", () => {
    const config = buildOpencodeConfig({ model: "anthropic/claude-sonnet-5" }) as {
      permission: { bash: Record<string, string> };
    };
    expect(config.permission.bash["git push*"]).toBeUndefined();
    expect(config.permission.bash["gh pr create*"]).toBeUndefined();
  });
});

// ADR 0048: read-only comes from the structured readOnly flag
// (AgentRun.spec.readOnly) and nothing else -- the goal is attacker-influenced
// event text and must have no say in the mode either way.
describe("isReadOnly", () => {
  const LEGACY_SENTINEL = "SWE-ENFORCED-MODE: review-only";
  const bashFor = (run: { readOnly: boolean; goal: string }): Record<string, string> =>
    (buildOpencodeConfig({ model: "m", readOnly: isReadOnly(run) }) as { permission: { bash: Record<string, string> } })
      .permission.bash;

  it("is enabled by readOnly with an ordinary goal, and denies push/PR", () => {
    const run = { readOnly: true, goal: "Review this pull request." };
    expect(isReadOnly(run)).toBe(true);
    for (const pattern of READ_ONLY_DENY_BASH_PATTERNS) expect(bashFor(run)[pattern]).toBe("deny");
  });

  it("is NOT enabled by the old goal sentinel when readOnly is false", () => {
    const run = { readOnly: false, goal: `${LEGACY_SENTINEL}\nPull request acme/widgets#7 ...` };
    expect(isReadOnly(run)).toBe(false);
    expect(bashFor(run)["git push*"]).toBeUndefined();
    expect(bashFor(run)["gh pr create*"]).toBeUndefined();
  });

  it("treats a non-boolean truthy readOnly as a normal run (strict === true)", () => {
    expect(isReadOnly({ readOnly: "true" as unknown as boolean })).toBe(false);
  });

  // Wiring guard: index.ts boots the agent at module load and can't be
  // imported in a test, so assert on its source that every guard is fed from
  // the runtime config's readOnly and the sentinel is gone.
  it("index.ts derives read-only from the runtime config, never the goal", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    expect(src).toContain("const readOnly = isReadOnly(runtimeConfig);");
    expect(src).toContain("buildOpencodeConfig({ model: toolConfig.model, readOnly })");
    expect(src).toContain("resolveUndelegatedToken(toolConfig, readOnly)");
    expect(src).toMatch(/resolveDelegatedToken\(toolConfig, [^,]+, readOnly,/);
    expect(src).not.toContain(LEGACY_SENTINEL);
    expect(src).not.toMatch(/isReviewMode|REVIEW_MODE_MARKER/);
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
