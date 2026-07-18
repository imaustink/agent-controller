import { describe, expect, it } from "vitest";
import { BlockedCommandError, tokenize, validateCommand } from "./allowlist.js";

describe("tokenize", () => {
  it("splits on whitespace and honors quotes", () => {
    expect(tokenize('get pods -n prod')).toEqual(["get", "pods", "-n", "prod"]);
    expect(tokenize(`get pods -l "app=foo bar"`)).toEqual(["get", "pods", "-l", "app=foo bar"]);
  });
});

describe("validateCommand", () => {
  it("accepts a plain get", () => {
    expect(validateCommand(["get", "pods", "-n", "prod"])).toEqual([
      "get",
      "pods",
      "-n",
      "prod",
      "--request-timeout=10s",
    ]);
  });

  it("accepts resource aliases and name positionals", () => {
    expect(validateCommand(["describe", "pod", "my-pod-abc123", "-n", "prod"])).toEqual([
      "describe",
      "pod",
      "my-pod-abc123",
      "-n",
      "prod",
      "--request-timeout=10s",
    ]);
  });

  it("accepts logs with no resource-kind check", () => {
    expect(validateCommand(["logs", "-n", "prod", "my-pod", "-c", "app", "--tail=200"])).toEqual([
      "logs",
      "-n",
      "prod",
      "my-pod",
      "-c",
      "app",
      "--tail=200",
      "--request-timeout=10s",
    ]);
  });

  it("rejects a mutating verb", () => {
    expect(() => validateCommand(["delete", "pod", "my-pod"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["exec", "-it", "my-pod", "--", "sh"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["apply", "-f", "evil.yaml"])).toThrow(BlockedCommandError);
  });

  it("rejects disallowed resource kinds", () => {
    expect(() => validateCommand(["get", "secrets"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "clusterrolebindings"])).toThrow(BlockedCommandError);
  });

  it("rejects disallowed flags", () => {
    expect(() => validateCommand(["get", "pods", "--kubeconfig=/tmp/x"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "pods", "--token=abc"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "pods", "--server=https://evil"])).toThrow(BlockedCommandError);
  });

  it("restricts --output to allowed values", () => {
    expect(() => validateCommand(["get", "pods", "-o", "yaml"])).not.toThrow();
    expect(() => validateCommand(["get", "pods", "-o", "go-template"])).toThrow(BlockedCommandError);
  });

  it("rejects an empty command", () => {
    expect(() => validateCommand([])).toThrow(BlockedCommandError);
  });
});
