import { describe, expect, it } from "vitest";
import { AgentConfigError, loadConfig } from "./config.js";

describe("loadConfig reply-ack overrides", () => {
  const base = { AGENT_NATS_URL: "nats://x", AGENT_RUN_ID: "run-1", AGENT_GOAL: "do it" };

  it("omits the overrides entirely when unset, so the runtime default applies", () => {
    const cfg = loadConfig(base as NodeJS.ProcessEnv, []);
    expect(cfg.replyAckTimeoutMs).toBeUndefined();
    expect(cfg.replyAckRetryMs).toBeUndefined();
  });

  it("reads both overrides", () => {
    const cfg = loadConfig({ ...base, AGENT_REPLY_ACK_TIMEOUT_MS: "5000", AGENT_REPLY_ACK_RETRY_MS: "250" } as NodeJS.ProcessEnv, []);
    expect(cfg.replyAckTimeoutMs).toBe(5000);
    expect(cfg.replyAckRetryMs).toBe(250);
  });

  it("accepts 0 as an explicit 'do not hold'", () => {
    expect(loadConfig({ ...base, AGENT_REPLY_ACK_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv, []).replyAckTimeoutMs).toBe(0);
  });

  /**
   * A typo'd timeout that silently reads as "use the default" would only be
   * discovered during the incident the setting was meant to prevent.
   */
  it("fails fast on a non-numeric or negative value", () => {
    expect(() => loadConfig({ ...base, AGENT_REPLY_ACK_TIMEOUT_MS: "10s" } as NodeJS.ProcessEnv, [])).toThrow(AgentConfigError);
    expect(() => loadConfig({ ...base, AGENT_REPLY_ACK_RETRY_MS: "-1" } as NodeJS.ProcessEnv, [])).toThrow(AgentConfigError);
  });
});
