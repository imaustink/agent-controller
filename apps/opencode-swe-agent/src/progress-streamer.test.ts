import { describe, expect, it } from "vitest";
import { ProgressStreamer, splitIntoChunks } from "./progress-streamer.js";

describe("splitIntoChunks", () => {
  it("returns the whole text as a single chunk when it already fits", () => {
    expect(splitIntoChunks("hello", 16)).toEqual(["hello"]);
  });

  it("breaks long text into multiple chunks at word boundaries", () => {
    const chunks = splitIntoChunks("the quick brown fox jumps over the lazy dog", 12);
    expect(chunks.join("")).toBe("the quick brown fox jumps over the lazy dog");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(13); // may overshoot slightly to the next space
  });

  it("falls back to a hard cut when there's no whitespace to break on", () => {
    const chunks = splitIntoChunks("a".repeat(40), 10);
    expect(chunks).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(10), "a".repeat(10)]);
  });

  it("never drops or reorders characters, regardless of chunk size", () => {
    const text = "one two three four five six seven eight nine ten";
    expect(splitIntoChunks(text, 5).join("")).toBe(text);
  });
});

describe("ProgressStreamer", () => {
  it("emits pushed text back out, in order, across chunk boundaries", async () => {
    const emitted: string[] = [];
    const streamer = new ProgressStreamer((chunk) => emitted.push(chunk), { chunkSize: 5, delayMs: 1 });
    streamer.push("hello there friend");
    await streamer.waitUntilDrained();
    expect(emitted.join("")).toBe("hello there friend");
    expect(emitted.length).toBeGreaterThan(1);
  });

  it("preserves order across multiple pushes made before draining completes", async () => {
    const emitted: string[] = [];
    const streamer = new ProgressStreamer((chunk) => emitted.push(chunk), { chunkSize: 4, delayMs: 1 });
    streamer.push("first block");
    streamer.push("second block");
    await streamer.waitUntilDrained();
    expect(emitted.join("")).toBe("first blocksecond block");
  });

  it("waitUntilDrained resolves once all queued text has been emitted", async () => {
    const emitted: string[] = [];
    const streamer = new ProgressStreamer((chunk) => emitted.push(chunk), { chunkSize: 3, delayMs: 2 });
    streamer.push("streaming text output");
    await streamer.waitUntilDrained();
    expect(emitted.join("")).toBe("streaming text output");
  });

  it("ignores empty pushes", async () => {
    const emitted: string[] = [];
    const streamer = new ProgressStreamer((chunk) => emitted.push(chunk), { delayMs: 1 });
    streamer.push("");
    await streamer.waitUntilDrained();
    expect(emitted).toEqual([]);
  });

  it("skips further inter-chunk delay once aborted, but still emits every queued chunk", async () => {
    const emitted: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const streamer = new ProgressStreamer((chunk) => emitted.push(chunk), {
      chunkSize: 4,
      delayMs: 1000,
      signal: controller.signal,
    });
    streamer.push("abort this stream please");
    // With the delay skipped, draining should complete quickly rather than
    // waiting out 1000ms per chunk.
    const start = Date.now();
    await streamer.waitUntilDrained();
    expect(Date.now() - start).toBeLessThan(500);
    expect(emitted.join("")).toBe("abort this stream please");
  });
});
