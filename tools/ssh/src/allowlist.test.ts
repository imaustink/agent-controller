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

  describe("ip", () => {
    it("accepts a read-only object with no action (ip's own default is list)", () => {
      expect(validateCommand(tokenize("ip addr"))).toEqual(["ip", "addr"]);
    });

    it("accepts an explicit read-only action", () => {
      expect(validateCommand(tokenize("ip -s link show"))).toEqual(["ip", "-s", "link", "show"]);
    });

    it("rejects ip link set ... down", () => {
      expect(() => validateCommand(tokenize("ip link set eth0 down"))).toThrow(BlockedCommandError);
    });

    it("rejects ip route del", () => {
      expect(() => validateCommand(tokenize("ip route del default"))).toThrow(BlockedCommandError);
    });

    it("rejects ip addr add", () => {
      expect(() => validateCommand(tokenize("ip addr add 10.0.0.9/24 dev eth0"))).toThrow(BlockedCommandError);
    });

    it("rejects an object outside the read-only set", () => {
      expect(() => validateCommand(tokenize("ip netconf show"))).toThrow(BlockedCommandError);
    });
  });

  describe("find", () => {
    it("accepts a plain read-only search", () => {
      expect(validateCommand(tokenize("find /var/log -name access.log"))).toEqual([
        "find",
        "/var/log",
        "-name",
        "access.log",
      ]);
    });

    it("rejects find -delete", () => {
      expect(() => validateCommand(tokenize("find /tmp/x -delete"))).toThrow(BlockedCommandError);
    });

    it("rejects find -exec", () => {
      expect(() => validateCommand(["find", "/tmp", "-exec", "rm", "{}", ";"])).toThrow(BlockedCommandError);
    });

    it("rejects find -fprint writing to an arbitrary file", () => {
      expect(() => validateCommand(tokenize("find / -name foo -fprint /etc/cron.d/x"))).toThrow(BlockedCommandError);
    });
  });
});
