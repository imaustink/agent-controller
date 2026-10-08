import { describe, expect, it } from "vitest";
import { BlockedCommandError, tokenize, validateCommand } from "./allowlist.js";

describe("tokenize", () => {
  it("splits on whitespace and honors quotes", () => {
    expect(tokenize("get pods -n prod")).toEqual(["get", "pods", "-n", "prod"]);
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
    expect(() => validateCommand(["patch", "pod", "my-pod"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["cp", "my-pod:/etc/passwd", "./passwd"])).toThrow(BlockedCommandError);
  });

  it("rejects disallowed resource kinds", () => {
    expect(() => validateCommand(["get", "clusterrolebindings"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "roles"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "customresourcedefinitions"])).toThrow(BlockedCommandError);
  });

  it("rejects disallowed flags", () => {
    expect(() => validateCommand(["get", "pods", "--kubeconfig=/tmp/x"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "pods", "--token=abc"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "pods", "--server=https://evil"])).toThrow(BlockedCommandError);
  });

  it("restricts --output to allowed values", () => {
    expect(() => validateCommand(["get", "pods", "-o", "yaml"])).not.toThrow();
    expect(() => validateCommand(["get", "pods", "-o", "go-template"])).toThrow(BlockedCommandError);
    expect(() => validateCommand(["get", "pods", "-o", "jsonpath={.items}"])).toThrow(BlockedCommandError);
  });

  it("allows secrets for get/describe but blocks json/yaml output (keys+lengths only)", () => {
    expect(validateCommand(["get", "secrets", "-n", "prod"])).toEqual([
      "get",
      "secrets",
      "-n",
      "prod",
      "--request-timeout=10s",
    ]);
    expect(validateCommand(["describe", "secret", "my-secret", "-n", "prod"])).toEqual([
      "describe",
      "secret",
      "my-secret",
      "-n",
      "prod",
      "--request-timeout=10s",
    ]);
    expect(() => validateCommand(["get", "secrets", "my-secret", "-o", "json"])).toThrow(
      BlockedCommandError,
    );
    expect(() => validateCommand(["get", "secret", "my-secret", "-o", "yaml"])).toThrow(
      BlockedCommandError,
    );
    // Flag order shouldn't matter: -o before the resource kind must be caught too.
    expect(() => validateCommand(["get", "-o", "json", "secrets", "my-secret"])).toThrow(
      BlockedCommandError,
    );
  });

  it("allows -o wide/name for secrets (no value data in those forms)", () => {
    expect(() => validateCommand(["get", "secrets", "-o", "wide"])).not.toThrow();
    expect(() => validateCommand(["get", "secrets", "-o", "name"])).not.toThrow();
  });

  it("does not restrict json/yaml output for other resource kinds", () => {
    expect(() => validateCommand(["get", "pods", "-o", "json"])).not.toThrow();
    expect(() => validateCommand(["get", "configmaps", "-o", "yaml"])).not.toThrow();
  });

  it("rejects an empty command", () => {
    expect(() => validateCommand([])).toThrow(BlockedCommandError);
  });
});
