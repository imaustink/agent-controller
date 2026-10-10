import { describe, expect, it } from "vitest";
import {
  authorize,
  PermissionDeniedError,
  TransientProbeError,
  type Granularity,
  type ProbeRequest,
  type ProbeResult,
  type Prober,
} from "./probe.js";
import type { CorpusSearchResult } from "./types.js";

/**
 * Answers per `connection/source`, counts the probes it was actually asked to
 * make, and can be switched to connection granularity.
 */
class FakeProber implements Prober {
  readonly probes: ProbeRequest[] = [];

  constructor(
    private readonly results: Record<string, ProbeResult> = {},
    private readonly errors: Record<string, Error> = {},
    private readonly unit: Granularity = "resource",
  ) {}

  granularity(): Granularity {
    return this.unit;
  }

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    this.probes.push(request);
    const key = `${request.connectionId}/${request.sourceId ?? ""}`;
    const failure = this.errors[key];
    if (failure) throw failure;
    return this.results[key] ?? { allowed: false, title: "", url: "" };
  }
}

function candidate(
  connectionId: string,
  sourceId: string,
  version: string,
  score: number,
): CorpusSearchResult {
  return {
    score,
    chunk: {
      connectionId,
      sourceId,
      version,
      // Deliberately misleading mirror metadata: authorize must never let these
      // reach a citation.
      title: "STALE MIRROR TITLE",
      sourceUrl: "https://mirror.invalid/leaked",
      contentHash: `${connectionId}${sourceId}${version}`,
      text: "…passage…",
    },
  };
}

describe("authorize", () => {
  it("takes citation fields from the probe, not the mirror", async () => {
    const prober = new FakeProber({
      "globex-confluence/page-1": {
        allowed: true,
        title: "Auth design",
        url: "https://example.atlassian.net/wiki/page-1",
        version: "v7",
      },
    });

    const outcome = await authorize(prober, [candidate("globex-confluence", "page-1", "v7", 0.9)]);

    expect(outcome.chunks).toHaveLength(1);
    // Citations are content: a title or URL from the mirror would bypass the
    // whole design at the last step.
    expect(outcome.chunks[0].title).toBe("Auth design");
    expect(outcome.chunks[0].url).not.toContain("mirror.invalid");
  });

  it("drops what the source refuses", async () => {
    const prober = new FakeProber(
      { "globex-confluence/page-1": { allowed: true, title: "Readable", url: "u", version: "v1" } },
      { "globex-confluence/page-2": new PermissionDeniedError("403") },
    );

    const outcome = await authorize(prober, [
      candidate("globex-confluence", "page-1", "v1", 0.9),
      candidate("globex-confluence", "page-2", "v1", 0.8),
    ]);

    expect(outcome.chunks).toHaveLength(1);
    expect(outcome.denied).toBe(1);
    expect(outcome.undetermined).toEqual([]);
  });

  it("treats allowed:false as a denial", async () => {
    const outcome = await authorize(new FakeProber({ "c/s": { allowed: false, title: "", url: "" } }), [
      candidate("c", "s", "v1", 0.5),
    ]);

    expect(outcome.chunks).toEqual([]);
    expect(outcome.denied).toBe(1);
  });

  it("does not silently drop on a transient failure", async () => {
    const prober = new FakeProber(
      { "c/ok": { allowed: true, title: "t", url: "u", version: "v1" } },
      { "c/busy": new TransientProbeError("429 rate limited") },
    );

    const outcome = await authorize(prober, [
      candidate("c", "ok", "v1", 0.9),
      candidate("c", "busy", "v1", 0.8),
    ]);

    expect(outcome.chunks).toHaveLength(1);
    // A 429 is not a denial. Counting it as one would quietly shrink the answer
    // and make the same question return different evidence on a retry.
    expect(outcome.denied).toBe(0);
    expect(outcome.undetermined).toEqual(["c/busy"]);
  });

  it("fails on an unclassified driver error", async () => {
    const prober = new FakeProber({}, { "c/s": new Error("driver forgot to classify this") });

    // Guessing whether an unclassified error meant "denied" or "busy" is how a
    // leak gets introduced, so it fails the search instead.
    await expect(authorize(prober, [candidate("c", "s", "v1", 0.5)])).rejects.toThrow(
      /forgot to classify/,
    );
  });

  it("de-duplicates probes per source", async () => {
    const prober = new FakeProber({
      "c/page-1": { allowed: true, title: "t", url: "u", version: "v1" },
    });

    const hits = Array.from({ length: 8 }, (_, i) => {
      const hit = candidate("c", "page-1", "v1", i / 10);
      hit.chunk.contentHash = `chunk-${i}`; // eight chunks, one page
      return hit;
    });

    const outcome = await authorize(prober, hits);

    expect(outcome.chunks).toHaveLength(8);
    expect(prober.probes).toHaveLength(1);
  });

  it("probes once per connection for channel-scoped providers", async () => {
    // Slack authorizes a CHANNEL: membership is the access unit, so one probe
    // settles every candidate from that connection.
    const prober = new FakeProber(
      { "globex-slack-eng/": { allowed: true, title: "#globex-eng", url: "u" } },
      {},
      "connection",
    );

    const outcome = await authorize(prober, [
      candidate("globex-slack-eng", "msg-1", "", 0.9),
      candidate("globex-slack-eng", "msg-2", "", 0.8),
      candidate("globex-slack-eng", "msg-3", "", 0.7),
    ]);

    expect(outcome.chunks).toHaveLength(3);
    expect(prober.probes).toHaveLength(1);
  });

  it("marks stale when the source has moved on", async () => {
    const prober = new FakeProber({
      "c/page-1": { allowed: true, title: "t", url: "u", version: "v9" },
      "c/page-2": { allowed: true, title: "t", url: "u", version: "v2" },
      "c/page-3": { allowed: true, title: "t", url: "u" },
    });

    const outcome = await authorize(prober, [
      candidate("c", "page-1", "v7", 0.9), // indexed at v7, source at v9
      candidate("c", "page-2", "v2", 0.8), // current
      candidate("c", "page-3", "v1", 0.7), // provider reports no version
    ]);

    expect(outcome.chunks[0].stale).toBe(true);
    expect(outcome.chunks[1].stale).toBe(false);
    // A provider reporting no version cannot show a chunk to be stale.
    expect(outcome.chunks[2].stale).toBe(false);
  });

  it("preserves rank order", async () => {
    const prober = new FakeProber({
      "c/a": { allowed: true, title: "a", url: "ua", version: "v1" },
      "c/b": { allowed: true, title: "b", url: "ub", version: "v1" },
      "c/c": { allowed: true, title: "c", url: "uc", version: "v1" },
    });

    const outcome = await authorize(prober, [
      candidate("c", "a", "v1", 0.9),
      candidate("c", "b", "v1", 0.5),
      candidate("c", "c", "v1", 0.1),
    ]);

    expect(outcome.chunks.map((c) => c.title)).toEqual(["a", "b", "c"]);
  });

  it("handles no candidates", async () => {
    const outcome = await authorize(new FakeProber(), []);
    expect(outcome.chunks).toEqual([]);
  });
});
