import { describe, expect, it } from "vitest";
import { BlockedCommandError, tokenize, validateCommand } from "./allowlist.js";

describe("tokenize", () => {
  it("splits on whitespace and honors quotes", () => {
    expect(tokenize("issue view 86 --repo imaustink/agent-controller")).toEqual([
      "issue",
      "view",
      "86",
      "--repo",
      "imaustink/agent-controller",
    ]);
    expect(tokenize(`issue comment 86 --body "hello world"`)).toEqual([
      "issue",
      "comment",
      "86",
      "--body",
      "hello world",
    ]);
  });
});

describe("validateCommand", () => {
  it("accepts an allowed command + subcommand, passing flags through unmodified", () => {
    expect(validateCommand(["issue", "view", "86", "--repo", "imaustink/agent-controller", "--json", "title,body"])).toEqual([
      "issue",
      "view",
      "86",
      "--repo",
      "imaustink/agent-controller",
      "--json",
      "title,body",
    ]);
  });

  it("accepts every allowed top-level command with at least one subcommand", () => {
    expect(() => validateCommand(["issue", "list"])).not.toThrow();
    expect(() => validateCommand(["pr", "view", "42"])).not.toThrow();
    expect(() => validateCommand(["repo", "view"])).not.toThrow();
    expect(() => validateCommand(["release", "list"])).not.toThrow();
    expect(() => validateCommand(["gist", "create"])).not.toThrow();
    expect(() => validateCommand(["label", "list"])).not.toThrow();
    expect(() => validateCommand(["search", "issues", "some query"])).not.toThrow();
    expect(() => validateCommand(["workflow", "view", "ci.yml"])).not.toThrow();
    expect(() => validateCommand(["run", "list"])).not.toThrow();
  });

  it("rejects a disallowed top-level command", () => {
    expect(() => validateCommand(["auth", "status"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["api", "repos/owner/repo"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["config", "set", "editor", "vim"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["secret", "list"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["ssh-key", "list"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["codespace", "list"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["browse"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["extension", "install", "foo/bar"])).toThrow(BlockedCommandError);
  });

  it("rejects a disallowed subcommand of an otherwise-allowed command", () => {
    expect(() => validateCommand(["issue", "delete", "86"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["issue", "transfer", "86", "other/repo"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["repo", "delete", "owner/repo"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["repo", "edit", "--visibility", "public"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["release", "delete", "v1.0.0"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["workflow", "run", "ci.yml"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["run", "cancel", "123"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["label", "delete", "bug"])).toThrow(BlockedCommandError);
  });

  it("rejects an empty command", () => {
    expect(() => validateCommand([])).toThrow(BlockedCommandError);
  });

  it("rejects a bare top-level command with no subcommand", () => {
    expect(() => validateCommand(["issue"])).toThrow(BlockedCommandError);
  });
});

describe("validateCommand read-only (TOOL_READ_ONLY)", () => {
  const ro = { readOnly: true };

  it("allows read subcommands", () => {
    expect(validateCommand(["issue", "view", "86"], ro)).toEqual(["issue", "view", "86"]);
    expect(() => validateCommand(["pr", "diff", "7"], ro)).not.toThrow();
    expect(() => validateCommand(["pr", "checks", "7"], ro)).not.toThrow();
    expect(() => validateCommand(["search", "code", "foo"], ro)).not.toThrow();
    expect(() => validateCommand(["run", "view", "123"], ro)).not.toThrow();
  });

  it("refuses every write subcommand that is otherwise allowed", () => {
    for (const argv of [
      ["issue", "create", "--title", "x"],
      ["issue", "comment", "86", "--body", "x"],
      ["issue", "edit", "86"],
      ["issue", "close", "86"],
      ["issue", "reopen", "86"],
      ["pr", "create"],
      ["pr", "comment", "7"],
      ["pr", "edit", "7"],
      ["pr", "close", "7"],
      ["pr", "reopen", "7"],
      ["pr", "merge", "7"],
      ["pr", "review", "7", "--approve"],
      ["gist", "create", "f.txt"],
      ["label", "create", "bug"],
    ]) {
      expect(() => validateCommand(argv, ro), argv.join(" ")).toThrow(/read-only/);
      // ...and each is genuinely allowed when not read-only, so the refusal above is the read-only gate.
      expect(() => validateCommand(argv), argv.join(" ")).not.toThrow();
    }
  });

  it("still applies the base allowlist", () => {
    expect(() => validateCommand(["api", "repos/o/r"], ro)).toThrow(BlockedCommandError);
  });
});
