import { describe, it, expect } from "vitest";
import type { Sink } from "@controller-agent/messaging";
import { createSink, JobEmitter } from "./index.js";
import type { PublishResult } from "../schema.js";
import type { AppConfig } from "../config.js";

const result: PublishResult = {
  slug: "pancakes",
  name: "Pancakes",
  url: "https://recipes.kurpuis.com/g/home/r/pancakes",
};

class MemorySink implements Sink<PublishResult> {
  readonly events: unknown[] = [];
  async emit(event: unknown): Promise<void> {
    this.events.push(event);
  }
  async close(): Promise<void> {}
}

describe("JobEmitter (recipe-publisher wiring)", () => {
  it("redacts a bearer token leaking into a free-text message via the tool's clip()", async () => {
    const sink = new MemorySink();
    const emitter = new JobEmitter("job-1", sink);
    const token = `${"a".repeat(30)}`;

    await emitter.warning(`unexpected header echoed token Bearer ${token}`);

    const event = sink.events[0] as { type: string; message: string };
    expect(event.type).toBe("warning");
    expect(event.message).not.toContain(token);
    expect(event.message).toContain("[REDACTED]");
  });

  it("still validates the underlying event envelope shape", async () => {
    const sink = new MemorySink();
    const emitter = new JobEmitter("job-2", sink);
    await emitter.succeeded(result);
    expect(sink.events).toHaveLength(1);
  });
});

describe("createSink", () => {
  const base: AppConfig = {
    mealieBaseUrl: "https://recipes.kurpuis.com",
    mealieApiToken: "x",
    mealieIngredientParser: "nlp",
    fetchTimeoutMs: 1,
    transport: "stdout",
    jobId: "job",
    eventsPath: "/tmp/recipe-publisher-events.ndjson",
    callbackUrl: undefined,
    callbackSecret: undefined,
    callbackAllowedHosts: [],
    callbackMaxRetries: 1,
  };

  it("defaults to the legacy final-result stdout sink", () => {
    expect(createSink(base).constructor.name).toBe("StdoutSink");
  });

  it("throws when callback transport is selected without a URL", () => {
    expect(() => createSink({ ...base, transport: "callback" })).toThrow(/RECIPE_CALLBACK_URL/);
  });
});
