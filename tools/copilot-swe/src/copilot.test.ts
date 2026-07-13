import { describe, expect, it } from "vitest";
import { buildCopilotArgs, buildPrompt, DENY_TOOLS, extractProgressText } from "./copilot.js";

describe("DENY_TOOLS", () => {
  it("blocks irreversible actions", () => {
    expect(DENY_TOOLS).toContain("shell(git push --force)");
    expect(DENY_TOOLS).toContain("shell(git push -f)");
    expect(DENY_TOOLS).toContain("shell(gh repo delete)");
    expect(DENY_TOOLS).toContain("shell(git reset --hard)");
    expect(DENY_TOOLS).toContain("shell(rm -rf)");
  });
});

describe("buildCopilotArgs", () => {
  it("builds a headless programmatic invocation with guardrails", () => {
    const args = buildCopilotArgs({ prompt: "do the thing", workdir: "/tmp/work" });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("do the thing");
    expect(args).toContain("--allow-all-tools");
    expect(args).toContain("--no-ask-user");
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args[args.indexOf("--deny-tool") + 1]).toBe(DENY_TOOLS.join(","));
    expect(args[args.indexOf("-C") + 1]).toBe("/tmp/work");
    expect(args).not.toContain("--model");
  });

  it("pins the model when provided", () => {
    const args = buildCopilotArgs({ prompt: "x", workdir: "/w", model: "claude-sonnet-4.6" });
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4.6");
  });
});

describe("buildPrompt", () => {
  it("embeds the instruction and first-turn repo guidance", () => {
    const prompt = buildPrompt("add a README", null);
    expect(prompt).toContain("add a README");
    expect(prompt).toContain("gh repo create");
    expect(prompt).toContain("NEVER force-push");
  });

  it("pins repo/branch/pr context on a continuation turn", () => {
    const prompt = buildPrompt("add tests", { repo: "octo/hello", branch: "feat-x", pr: "12", session: "s" });
    expect(prompt).toContain("octo/hello");
    expect(prompt).toContain("feat-x");
    expect(prompt).toContain("#12");
  });
});

describe("extractProgressText", () => {
  it("pulls a text field from a JSON line", () => {
    expect(extractProgressText('{"text":"editing app.ts"}')).toBe("editing app.ts");
  });

  it("falls back to a tool name", () => {
    expect(extractProgressText('{"tool":"bash"}')).toBe("running bash");
  });

  it("returns null for non-JSON or empty lines", () => {
    expect(extractProgressText("not json")).toBeNull();
    expect(extractProgressText("")).toBeNull();
    expect(extractProgressText("{}")).toBeNull();
  });
});
