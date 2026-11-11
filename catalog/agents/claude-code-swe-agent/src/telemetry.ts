import type { AgentTelemetry } from "@aktis/agent-runtime";

/**
 * The env that makes the Claude Code CLI export its own spans into the
 * launching turn's trace (docs/adr/0050 §3c). Per Claude Code's monitoring
 * docs (code.claude.com/docs/en/monitoring-usage):
 *
 * - Spans are beta: CLAUDE_CODE_ENABLE_TELEMETRY + CLAUDE_CODE_ENHANCED_
 *   TELEMETRY_BETA + OTEL_TRACES_EXPORTER=otlp are all required.
 * - In `-p` (non-interactive) runs the CLI reads TRACEPARENT from its env, so
 *   its interaction span becomes a child of the turn's (the pod already has
 *   it; it is inherited).
 * - There is no default OTLP protocol, and the docs do not say whether the
 *   generic endpoint gets `/v1/traces` appended -- so the traces endpoint is
 *   given explicitly.
 * - Metrics and logs are off: the collector's pipeline, and Langfuse, take
 *   traces only.
 * - Prompt, response and tool text are redacted by default; they are turned
 *   on only for a run the engine cleared for content (ADR 0050 §5).
 */
export function claudeCodeTelemetryEnv(t: AgentTelemetry | undefined): Record<string, string> {
  if (!t) return {};
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${t.otlpEndpoint}/v1/traces`,
  };
  if (t.traceparent) env.TRACEPARENT = t.traceparent;
  if (t.captureContent) {
    env.OTEL_LOG_USER_PROMPTS = "1";
    env.OTEL_LOG_ASSISTANT_RESPONSES = "1";
    env.OTEL_LOG_TOOL_DETAILS = "1";
    env.OTEL_LOG_TOOL_CONTENT = "1";
  } else {
    // Explicit, not just unset: a value inherited from elsewhere must not
    // turn text capture on for a run the engine kept to metadata.
    env.OTEL_LOG_USER_PROMPTS = "0";
    env.OTEL_LOG_ASSISTANT_RESPONSES = "0";
    env.OTEL_LOG_TOOL_DETAILS = "0";
    env.OTEL_LOG_TOOL_CONTENT = "0";
  }
  return env;
}
