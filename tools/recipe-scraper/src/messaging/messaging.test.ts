import { describe, it, expect } from "vitest";
import type { Sink } from "@recipe-agent/messaging";
import { createSink, JobEmitter } from "./index.js";
import type { AppConfig } from "../config.js";

const markdown = "# Test Recipe\n\n## Ingredients\n\n1. 2 eggs";

class MemorySink implements Sink<string> {
  readonly events: unknown[] = [];
  async emit(event: unknown): Promise<void> {
    this.events.push(event);
  }
  async close(): Promise<void> {}
}

describe("JobEmitter (recipe-scraper wiring)", () => {
  it("redacts secrets in free-text messages via the tool's clip()", async () => {
    const sink = new MemorySink();
    const emitter = new JobEmitter("job-1", sink);

    await emitter.warning("leaked sk-abcdefghijklmnopqrstuvwx here");

    const event = sink.events[0] as { type: string; message: string };
    expect(event.type).toBe("warning");
    expect(event.message).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(event.message).toContain("[REDACTED]");
  });

  it("still validates the underlying event envelope shape", async () => {
    const sink = new MemorySink();
    const emitter = new JobEmitter("job-2", sink);
    await emitter.succeeded(markdown);
    expect(sink.events).toHaveLength(1);
  });
});

describe("createSink", () => {
  const base: AppConfig = {
    formatModel: "x",
    visionModel: "x",
    transcribeModel: "x",
    maxTextChars: 1,
    maxImageBytes: 1,
    maxAudioBytes: 1,
    navTimeoutMs: 1,
    subprocessTimeoutMs: 1,
    fetchTimeoutMs: 1,
    maxRedirects: 1,
    userAgent: "x",
    transport: "stdout",
    jobId: "job",
    eventsPath: "/tmp/recipe-events.ndjson",
    callbackUrl: undefined,
    callbackSecret: undefined,
    callbackAllowedHosts: [],
    callbackMaxRetries: 1,
  };

  it("defaults to the legacy final-envelope stdout sink", () => {
    expect(createSink(base).constructor.name).toBe("StdoutSink");
  });

  it("throws when callback transport is selected without a URL", () => {
    expect(() => createSink({ ...base, transport: "callback" })).toThrow(/RECIPE_CALLBACK_URL/);
  });
});
