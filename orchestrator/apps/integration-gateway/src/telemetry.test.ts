import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { setupTelemetry, startSpan, telemetryEnabled } from "./telemetry.js";
import { traceIdOf } from "./traceparent.js";

const INBOUND = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("telemetry (docs/adr/0050 §4)", () => {
  let exporter = new InMemorySpanExporter();
  let stop: () => Promise<void> = async () => {};
  afterEach(async () => {
    await stop();
    stop = async () => {};
    exporter = new InMemorySpanExporter();
  });
  const enable = (): void => {
    stop = setupTelemetry("test-service", { spanProcessor: new SimpleSpanProcessor(exporter) });
  };
  const flushed = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
  };

  it("installs nothing without an OTLP endpoint, and still continues the trace", async () => {
    stop = setupTelemetry("test-service", { env: {} });
    expect(telemetryEnabled()).toBe(false);
    const span = startSpan("x", INBOUND);
    expect(traceIdOf(span.traceparent)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.traceparent).not.toBe(INBOUND);
    expect(traceIdOf(startSpan("y", "garbage").traceparent)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("installs an exporter when OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
    stop = setupTelemetry("test-service", { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" } });
    expect(telemetryEnabled()).toBe(true);
    await stop();
    expect(telemetryEnabled()).toBe(false);
  });

  it("exports a child of a valid inbound traceparent whose context is the one to forward", async () => {
    enable();
    const span = startSpan("hop", INBOUND, { kind: "server" });
    span.end();
    await flushed();
    const [exported] = exporter.getFinishedSpans();
    expect(exported?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(exported?.parentSpanContext?.isRemote).toBe(true);
    expect(span.traceparent).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${exported!.spanContext().spanId}-01`);
    expect(exported?.resource.attributes["service.name"]).toBe("test-service");
  });

  it("roots a new trace for a missing or malformed parent", async () => {
    enable();
    startSpan("a", undefined).end();
    startSpan("b", "00-00000000000000000000000000000000-00f067aa0ba902b7-01").end();
    await flushed();
    for (const s of exporter.getFinishedSpans()) expect(s.parentSpanContext).toBeUndefined();
  });

  it("drops attributes outside the allowlist, so nothing credential-shaped is exported by accident", async () => {
    enable();
    const span = startSpan("hop", undefined, {
      attributes: { authorization: "Bearer secret", "x-gateway-user-assertion": "jwt", "aktis.trigger": "review", "aktis.empty": "" },
    });
    span.set({ "http.request.header.cookie": "c", "http.response.status_code": 202, "aktis.skip": undefined });
    span.end();
    await flushed();
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ "aktis.trigger": "review", "http.response.status_code": 202 });
  });

  it("records a failure as an error status with error.type, and ends once", async () => {
    enable();
    const span = startSpan("hop", undefined);
    span.fail("identity_link_required", "link your account");
    span.end();
    span.end();
    await flushed();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status).toEqual({ code: 2, message: "link your account" });
    expect(spans[0]?.attributes["error.type"]).toBe("identity_link_required");
  });
});
