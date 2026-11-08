import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Event } from "./event.js";
import { JobEmitter } from "./emitter.js";
import { CallbackSink, CallbackConfigError } from "./callback-sink.js";
import type { Sink } from "./sink.js";

interface Result {
  ok: boolean;
}

class MemorySink implements Sink<Result> {
  readonly events: Event<Result>[] = [];
  async emit(event: Event<Result>): Promise<void> {
    this.events.push(event);
  }
  async close(): Promise<void> {}
}

describe("JobEmitter", () => {
  it("emits monotonically increasing seq with a stable job_id", async () => {
    const sink = new MemorySink();
    const emitter = new JobEmitter<Result>("job-42", sink);

    await emitter.accepted("https://example.com/recipe");
    await emitter.progress("extract", { pct: 10 });
    await emitter.succeeded({ ok: true });

    expect(sink.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(sink.events.every((e) => e.job_id === "job-42")).toBe(true);
    expect(sink.events.map((e) => e.type)).toEqual(["accepted", "progress", "succeeded"]);
  });

  it("defaults to truncating long free-text messages without a sanitize option", async () => {
    const sink = new MemorySink();
    const emitter = new JobEmitter<Result>("job-1", sink);

    await emitter.warning("x".repeat(1000));

    const event = sink.events[0];
    expect(event?.type).toBe("warning");
    if (event?.type === "warning") {
      expect(event.message.length).toBe(501); // 500 chars + ellipsis
    }
  });

  it("applies an injected sanitize function to every free-text field", async () => {
    const sink = new MemorySink();
    const sanitize = vi.fn((s: string) => s.replace(/secret/g, "[REDACTED]"));
    const emitter = new JobEmitter<Result>("job-2", sink, { sanitize });

    await emitter.warning("leaked secret here");
    await emitter.failed("boom", "another secret leaked");

    expect(sanitize).toHaveBeenCalled();
    const [warn, failed] = sink.events;
    expect(warn?.type).toBe("warning");
    if (warn?.type === "warning") expect(warn.message).toBe("leaked [REDACTED] here");
    expect(failed?.type).toBe("failed");
    if (failed?.type === "failed") expect(failed.message).toBe("another [REDACTED] leaked");
  });

  it("validates artifact refs passed to succeeded", async () => {
    const sink = new MemorySink();
    const emitter = new JobEmitter<Result>("job-3", sink);

    await expect(
      emitter.succeeded({ ok: true }, [{ uri: "s3://x", sha256: "abc", bytes: -1, content_type: "x" } as never]),
    ).rejects.toThrow();
  });
});

describe("CallbackSink", () => {
  const event: Event<Result> = {
    job_id: "job-9",
    seq: 3,
    ts: "2026-07-02T00:00:00Z",
    type: "warning",
    message: "hi",
  };

  it("rejects a non-http(s) URL", () => {
    expect(() => new CallbackSink({ url: "ftp://host/hook" })).toThrow(CallbackConfigError);
  });

  it("rejects a host outside the allowlist", () => {
    expect(
      () => new CallbackSink({ url: "https://evil.example/hook", allowedHosts: ["parent.internal"] }),
    ).toThrow(CallbackConfigError);
  });

  it("posts a signed, idempotent request", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = new CallbackSink<Result>({
      url: "https://parent.internal/hook",
      secret: "shh",
      allowedHosts: ["parent.internal"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await sink.emit(event);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("job-9:3");
    const expected = `sha256=${createHmac("sha256", "shh").update(init.body as string).digest("hex")}`;
    expect(headers["x-signature"]).toBe(expected);
  });

  it("retries on failure then throws after exhausting attempts", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const sink = new CallbackSink<Result>({
      url: "https://parent.internal/hook",
      maxRetries: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(sink.emit(event)).rejects.toThrow(/after 3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
