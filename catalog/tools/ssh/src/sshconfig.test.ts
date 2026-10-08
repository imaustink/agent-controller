import { describe, expect, it } from "vitest";
import { parseSshConfig, resolveAlias } from "./sshconfig.js";

describe("parseSshConfig", () => {
  it("parses a Host block's HostName/User/Port", () => {
    const entries = parseSshConfig(`
      Host kube0
        HostName 192.168.1.59
        User ubuntu
        Port 2222
    `);
    expect(entries).toEqual([{ patterns: ["kube0"], hostName: "192.168.1.59", user: "ubuntu", port: 2222 }]);
  });

  it("ignores unsupported directives and comments", () => {
    const entries = parseSshConfig(`
      # a comment
      Host bastion
        HostName 192.168.1.43
        IdentityFile ~/.ssh/id_rsa
        ProxyJump jumpbox
    `);
    expect(entries).toEqual([{ patterns: ["bastion"], hostName: "192.168.1.43" }]);
  });

  it("ignores directives before any Host line", () => {
    const entries = parseSshConfig("User orphan\nHost kube0\n  User ubuntu\n");
    expect(entries).toEqual([{ patterns: ["kube0"], user: "ubuntu" }]);
  });

  it("supports multiple space-separated patterns on one Host line", () => {
    const entries = parseSshConfig("Host kube0 kube0.local\n  User ubuntu\n");
    expect(entries[0]?.patterns).toEqual(["kube0", "kube0.local"]);
  });
});

describe("resolveAlias", () => {
  it("resolves an exact match", () => {
    const entries = parseSshConfig("Host kube0\n  HostName 192.168.1.59\n  User ubuntu\n");
    expect(resolveAlias("kube0", entries)).toEqual({
      matched: true,
      hostName: "192.168.1.59",
      user: "ubuntu",
      port: undefined,
    });
  });

  it("merges a specific Host block with a trailing wildcard default", () => {
    const entries = parseSshConfig(`
      Host kube0
        HostName 192.168.1.59
      Host *
        User ubuntu
    `);
    expect(resolveAlias("kube0", entries)).toEqual({ matched: true, hostName: "192.168.1.59", user: "ubuntu", port: undefined });
  });

  it("lets an earlier specific block win over a later wildcard for the same field", () => {
    const entries = parseSshConfig(`
      Host kube0
        User ubuntu
      Host *
        User fallback
    `);
    expect(resolveAlias("kube0", entries).user).toBe("ubuntu");
  });

  it("reports no match for an alias no pattern covers", () => {
    expect(resolveAlias("unknown-host", parseSshConfig("Host kube0\n  User ubuntu\n"))).toEqual({ matched: false });
  });

  it("matches a wildcard pattern", () => {
    const entries = parseSshConfig("Host kube*\n  User ubuntu\n");
    expect(resolveAlias("kube0", entries).matched).toBe(true);
    expect(resolveAlias("db1", entries).matched).toBe(false);
  });
});
