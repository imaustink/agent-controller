import { describe, expect, it } from "vitest";
import { parseSshConfig } from "./sshconfig.js";
import { BlockedTargetError, resolveTarget, type Target, type TargetResolutionConfig } from "./target.js";

const NO_CONFIG: TargetResolutionConfig = { sshConfigEntries: [], defaultUser: undefined, allowedHosts: null };

const ALLOWED_HOSTS: Target[] = [
  { user: "monitor", host: "nas.kurpuis.internal", port: 22 },
  { user: "monitor", host: "bastion.kurpuis.internal", port: 2222 },
];

describe("resolveTarget -- allowlist only (no SSH_CONFIG)", () => {
  const cfg: TargetResolutionConfig = { sshConfigEntries: [], defaultUser: undefined, allowedHosts: ALLOWED_HOSTS };

  it("accepts a bare host that matches an allowlist entry", () => {
    expect(resolveTarget("monitor@nas.kurpuis.internal", cfg)).toEqual(ALLOWED_HOSTS[0]);
  });

  it("accepts user@host:port that matches exactly", () => {
    expect(resolveTarget("monitor@bastion.kurpuis.internal:2222", cfg)).toEqual(ALLOWED_HOSTS[1]);
  });

  it("rejects a host not in the allowlist", () => {
    expect(() => resolveTarget("monitor@evil.example.com", cfg)).toThrow(BlockedTargetError);
  });

  it("rejects a mismatched user for an allowlisted host", () => {
    expect(() => resolveTarget("root@nas.kurpuis.internal", cfg)).toThrow(BlockedTargetError);
  });

  it("rejects a mismatched port for an allowlisted host", () => {
    expect(() => resolveTarget("monitor@nas.kurpuis.internal:2222", cfg)).toThrow(BlockedTargetError);
  });

  it("rejects a target string with shell metacharacters", () => {
    expect(() => resolveTarget("monitor@nas.kurpuis.internal;rm -rf /", cfg)).toThrow(BlockedTargetError);
  });

  it("requires a user when none is configured anywhere", () => {
    expect(() => resolveTarget("nas.kurpuis.internal", cfg)).toThrow(BlockedTargetError);
  });
});

describe("resolveTarget -- SSH_CONFIG only (no allowlist)", () => {
  const sshConfigEntries = parseSshConfig(`
    Host kube0
      HostName 192.168.1.59
      User ubuntu
    Host *
      Port 2222
  `);
  const cfg: TargetResolutionConfig = { sshConfigEntries, defaultUser: undefined, allowedHosts: null };

  it("resolves an alias via the config file with no allowlist restriction", () => {
    expect(resolveTarget("kube0", cfg)).toEqual({ user: "ubuntu", host: "192.168.1.59", port: 2222 });
  });

  it("lets an explicit user@ override the config's User", () => {
    expect(resolveTarget("root@kube0", cfg)).toEqual({ user: "root", host: "192.168.1.59", port: 2222 });
  });

  it("falls back to the literal host when no Host block matches", () => {
    expect(resolveTarget("ubuntu@192.168.1.99", cfg)).toEqual({ user: "ubuntu", host: "192.168.1.99", port: 2222 });
  });
});

describe("resolveTarget -- SSH_CONFIG + allowlist together", () => {
  const sshConfigEntries = parseSshConfig("Host kube0\n  HostName 192.168.1.59\n  User ubuntu\n");
  const allowedHosts: Target[] = [{ user: "ubuntu", host: "192.168.1.59", port: 22 }];
  const cfg: TargetResolutionConfig = { sshConfigEntries, defaultUser: undefined, allowedHosts };

  it("allows an alias that resolves onto an allowlisted target", () => {
    expect(resolveTarget("kube0", cfg)).toEqual({ user: "ubuntu", host: "192.168.1.59", port: 22 });
  });

  it("blocks an alias that resolves to a target the allowlist doesn't cover", () => {
    const cfgWithOtherAlias: TargetResolutionConfig = {
      sshConfigEntries: parseSshConfig("Host other\n  HostName 10.0.0.9\n  User ubuntu\n"),
      defaultUser: undefined,
      allowedHosts,
    };
    expect(() => resolveTarget("other", cfgWithOtherAlias)).toThrow(BlockedTargetError);
  });
});

describe("resolveTarget -- defaultUser fallback", () => {
  it("uses SSH_DEFAULT_USER when the target and config both omit a user", () => {
    const cfg: TargetResolutionConfig = { ...NO_CONFIG, defaultUser: "monitor", allowedHosts: ALLOWED_HOSTS };
    expect(resolveTarget("nas.kurpuis.internal", cfg)).toEqual(ALLOWED_HOSTS[0]);
  });
});
