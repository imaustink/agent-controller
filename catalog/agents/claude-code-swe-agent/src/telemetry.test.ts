import { describe, expect, it } from "vitest";
import { claudeCodeTelemetryEnv } from "./telemetry.js";

describe("claudeCodeTelemetryEnv (docs/adr/0050 §3c/§5)", () => {
  it("is empty when the run exports nothing", () => {
    expect(claudeCodeTelemetryEnv(undefined)).toEqual({});
  });

  it("exports CLI spans to the collector, parented on the turn, metadata only by default", () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const env = claudeCodeTelemetryEnv({ otlpEndpoint: "http://c:4318", traceparent: tp, captureContent: false });
    expect(env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      TRACEPARENT: tp,
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_CONTENT: "0",
    });
  });

  it("records text only for a run cleared for content", () => {
    const env = claudeCodeTelemetryEnv({ otlpEndpoint: "http://c:4318", captureContent: true });
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(env.OTEL_LOG_TOOL_CONTENT).toBe("1");
  });
});
