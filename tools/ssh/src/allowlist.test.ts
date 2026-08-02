import { describe, expect, it } from "vitest";
import { BlockedCommandError, tokenize, validateCommand } from "./allowlist.js";

describe("tokenize", () => {
  it("splits on whitespace and honors quoted spans", () => {
    expect(tokenize('systemctl status "docker.service"')).toEqual(["systemctl", "status", "docker.service"]);
  });
});

describe("validateCommand", () => {
  it("accepts an allowlisted command with plain-argument flags", () => {
    expect(validateCommand(tokenize("df -h"))).toEqual(["df", "-h"]);
  });

  it("accepts an allowlisted systemctl read-only subcommand", () => {
    expect(validateCommand(tokenize("systemctl status docker.service"))).toEqual([
      "systemctl",
      "status",
      "docker.service",
    ]);
  });

  it("rejects a systemctl subcommand outside the read-only set", () => {
    expect(() => validateCommand(tokenize("systemctl restart docker.service"))).toThrow(BlockedCommandError);
  });

  it("rejects a docker subcommand outside the read-only set", () => {
    expect(() => validateCommand(tokenize("docker rm my-container"))).toThrow(BlockedCommandError);
  });

  it("rejects a command not on the allowlist", () => {
    expect(() => validateCommand(tokenize("rm -rf /"))).toThrow(BlockedCommandError);
  });

  it("rejects an argument with shell metacharacters", () => {
    expect(() => validateCommand(tokenize("cat /etc/passwd; whoami"))).toThrow(BlockedCommandError);
  });

  it("rejects an argument with a command substitution", () => {
    expect(() => validateCommand(["cat", "$(whoami)"])).toThrow(BlockedCommandError);
  });

  it("rejects an empty command line", () => {
    expect(() => validateCommand([])).toThrow(BlockedCommandError);
  });
});
