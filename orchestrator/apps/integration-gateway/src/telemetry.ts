import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace, type AttributeValue, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { nextTraceparent, parseTraceparent } from "./traceparent.js";

/**
 * OpenTelemetry spans for this process (docs/adr/0050 §4). Exports only when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (the chart sets it, pointed at the
 * in-cluster collector, when `global.observability.enabled`). Unset, every
 * span is a stand-in that still mints/continues a W3C `traceparent`, so trace
 * context crosses this hop exactly as it did before this process exported
 * anything.
 *
 * Best effort by design, like the engine's: a batched, bounded exporter that
 * drops spans when the collector is unreachable and never slows or fails a
 * request. There is no auto-instrumentation -- every attribute is set
 * explicitly below and filtered through {@link SAFE_ATTRIBUTE}, so no header,
 * URL, body or credential reaches a span by accident.
 */

/**
 * Attribute keys a span may carry: our own namespace plus the few semantic
 * conventions we set. Anything else is dropped at the emitter (the collector
 * redacts token-shaped values a second time).
 */
const SAFE_ATTRIBUTE = /^(aktis\.[a-z0-9_.]+|http\.request\.method|http\.route|http\.response\.status_code|error\.type)$/;

export interface TraceSpan {
  /** The `traceparent` to forward on the next hop: this span's own context. */
  readonly traceparent: string;
  /** This span's trace id (32 hex chars). */
  readonly traceId: string;
  /** Sets attributes; keys outside the allowlist and empty values are dropped. */
  set(attributes: Record<string, AttributeValue | undefined>): void;
  /** Marks the span failed with a machine-readable code (`error.type`). */
  fail(code: string, message?: string): void;
  /** Ends the span. Idempotent. */
  end(): void;
}

export interface SpanOptions {
  kind?: "server" | "client" | "internal";
  attributes?: Record<string, AttributeValue | undefined>;
}

export interface TelemetryOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces the OTLP exporter (tests). */
  spanProcessor?: SpanProcessor;
}

let provider: BasicTracerProvider | undefined;
let tracer: Tracer | undefined;

/** Whether spans are being recorded and exported. */
export function telemetryEnabled(): boolean {
  return tracer !== undefined;
}

/**
 * Installs the tracer when an OTLP endpoint is configured. Returns a shutdown
 * that flushes what is buffered; a no-op when nothing was installed.
 */
export function setupTelemetry(defaultServiceName: string, options: TelemetryOptions = {}): () => Promise<void> {
  const env = options.env ?? process.env;
  if (!options.spanProcessor && !env.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => {};
  const serviceName = env.OTEL_SERVICE_NAME || defaultServiceName;
  const processor =
    options.spanProcessor ??
    // Reads OTEL_EXPORTER_OTLP_* itself (/v1/traces is appended). A full queue
    // drops spans rather than buffering without bound.
    new BatchSpanProcessor(new OTLPTraceExporter(), { maxQueueSize: 4096, scheduledDelayMillis: 2000 });
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": serviceName }),
    spanProcessors: [processor],
  });
  tracer = provider.getTracer("aktis/" + defaultServiceName);
  if (!options.spanProcessor) console.log(`[telemetry] exporting traces as ${serviceName}`);
  const installed = provider;
  return async () => {
    if (provider === installed) {
      provider = undefined;
      tracer = undefined;
    }
    // Bounded: a pod being terminated must not wait on an unreachable collector.
    await Promise.race([installed.shutdown().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
  };
}

const KIND = { server: SpanKind.SERVER, client: SpanKind.CLIENT, internal: SpanKind.INTERNAL } as const;

/**
 * Starts a span that continues `parent` (a W3C traceparent) when it is valid,
 * else roots a new trace. With telemetry off, returns a stand-in whose
 * `traceparent` is a fresh child of `parent` (or a new root).
 */
export function startSpan(name: string, parent: string | undefined, options: SpanOptions = {}): TraceSpan {
  if (!tracer) return standIn(parent);
  const remote = parseTraceparent(parent);
  const ctx = remote
    ? trace.setSpanContext(ROOT_CONTEXT, { traceId: remote.traceId, spanId: remote.spanId, traceFlags: remote.flags, isRemote: true })
    : ROOT_CONTEXT;
  const span = tracer.startSpan(name, { kind: KIND[options.kind ?? "internal"] }, ctx);
  const wrapped = wrap(span);
  if (options.attributes) wrapped.set(options.attributes);
  return wrapped;
}

function wrap(span: Span): TraceSpan {
  const sc = span.spanContext();
  const flags = (sc.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? "01" : "00";
  let ended = false;
  return {
    traceparent: `00-${sc.traceId}-${sc.spanId}-${flags}`,
    traceId: sc.traceId,
    set(attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === "" || !SAFE_ATTRIBUTE.test(key)) continue;
        span.setAttribute(key, value);
      }
    },
    fail(code, message) {
      span.setAttribute("error.type", code);
      span.setStatus({ code: SpanStatusCode.ERROR, ...(message ? { message } : {}) });
    },
    end() {
      if (ended) return;
      ended = true;
      span.end();
    },
  };
}

function standIn(parent: string | undefined): TraceSpan {
  const traceparent = nextTraceparent(parent);
  return {
    traceparent,
    traceId: parseTraceparent(traceparent)!.traceId,
    set() {},
    fail() {},
    end() {},
  };
}
