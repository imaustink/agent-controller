import { describe, expect, it } from "vitest";
import { buildCopilotArgs, buildPrompt, DENY_TOOLS, parseCopilotLine } from "./copilot.js";

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

describe("parseCopilotLine", () => {
  it("extracts an assistant final message", () => {
    const sig = parseCopilotLine('{"type":"assistant.message","data":{"content":"Opened PR #3"}}');
    expect(sig?.finalMessage).toBe("Opened PR #3");
  });

  it("ignores an assistant message with empty content (a tool-request message)", () => {
    const sig = parseCopilotLine('{"type":"assistant.message","data":{"content":"","toolRequests":[{}]}}');
    expect(sig).toBeNull();
  });

  it("narrates reasoning deltas as progress", () => {
    const sig = parseCopilotLine('{"type":"assistant.reasoning_delta","data":{"deltaContent":"Let me start"}}');
    expect(sig?.progress).toBe("Let me start");
  });

  it("narrates a tool execution start", () => {
    const sig = parseCopilotLine('{"type":"tool.execution_start","data":{"toolName":"bash","description":"create repo"}}');
    expect(sig?.progress).toBe("running bash: create repo");
  });

  it("flags a failed tool execution (success:false)", () => {
    const sig = parseCopilotLine('{"type":"tool.execution_complete","data":{"success":false,"result":{"content":"boom"}}}');
    expect(sig?.toolFailure).toBe("boom");
  });

  it("flags a non-zero shell exit as a tool failure", () => {
    const sig = parseCopilotLine(
      '{"type":"tool.execution_complete","data":{"success":true,"result":{"content":"Resource not accessible by personal access token (createRepository)\\n<shellId: 0 completed with exit code 1>"}}}',
    );
    expect(sig?.toolFailure).toContain("createRepository");
  });

  it("returns null for non-JSON, empty, or unrecognized lines", () => {
    expect(parseCopilotLine("not json")).toBeNull();
    expect(parseCopilotLine("")).toBeNull();
    expect(parseCopilotLine('{"type":"session.tools_updated","data":{}}')).toBeNull();
  });
});
