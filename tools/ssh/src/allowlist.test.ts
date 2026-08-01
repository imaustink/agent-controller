import { describe, expect, it } from "vitest";
import {
  BlockedCommandError,
  BlockedTargetError,
  tokenize,
  validateCommand,
  validateTarget,
  type Target,
} from "./allowlist.js";

const ALLOWED_HOSTS: Target[] = [
  { user: "monitor", host: "nas.kurpuis.internal", port: 22 },
  { user: "monitor", host: "bastion.kurpuis.internal", port: 2222 },
];

describe("tokenize", () => {
  it("splits on whitespace and honors quoted spans", () => {
    expect(tokenize('systemctl status "docker.service"')).toEqual(["systemctl", "status", "docker.service"]);
  });
});

describe("validateTarget", () => {
  it("accepts a bare host that matches an allowlist entry", () => {
    expect(validateTarget("nas.kurpuis.internal", ALLOWED_HOSTS)).toEqual(ALLOWED_HOSTS[0]);
  });

  it("accepts user@host:port that matches exactly", () => {
    expect(validateTarget("monitor@bastion.kurpuis.internal:2222", ALLOWED_HOSTS)).toEqual(ALLOWED_HOSTS[1]);
  });

  it("rejects a host not in the allowlist", () => {
    expect(() => validateTarget("evil.example.com", ALLOWED_HOSTS)).toThrow(BlockedTargetError);
  });

  it("rejects a mismatched user for an allowlisted host", () => {
    expect(() => validateTarget("root@nas.kurpuis.internal", ALLOWED_HOSTS)).toThrow(BlockedTargetError);
  });

  it("rejects a mismatched port for an allowlisted host", () => {
    expect(() => validateTarget("nas.kurpuis.internal:2222", ALLOWED_HOSTS)).toThrow(BlockedTargetError);
  });

  it("rejects a target string with shell metacharacters", () => {
    expect(() => validateTarget("nas.kurpuis.internal;rm -rf /", ALLOWED_HOSTS)).toThrow(BlockedTargetError);
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
