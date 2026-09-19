import { describe, expect, it, vi } from "vitest";
import { BrokerProber, retrieve } from "./retrieve.js";
import { PermissionDeniedError, TransientProbeError, type ProbeResult, type Prober } from "./probe.js";
import type { CorpusQueryFilter, CorpusSearchResult, CorpusStore } from "./types.js";

function hit(sourceId: string, contentHash: string, score: number): CorpusSearchResult {
  return {
    score,
    chunk: {
      connectionId: "c",
      sourceId,
      contentHash,
      sourceUrl: "https://mirror.invalid/x",
      title: "MIRROR TITLE",
      version: "v1",
      text: "…",
    },
  };
}

class FakeStore implements CorpusStore {
  constructor(
    private readonly hits: CorpusSearchResult[] = [],
    private readonly failure?: Error,
  ) {}
  async query(_t: string, _f: CorpusQueryFilter, k: number) {
    if (this.failure) throw this.failure;
    return [...this.hits].sort((a, b) => b.score - a.score).slice(0, k);
  }
}

class FakeProber implements Prober {
  probes = 0;
  constructor(
    private readonly results: Record<string, ProbeResult> = {},
    private readonly errors: Record<string, Error> = {},
  ) {}
  granularity() {
    return "resource" as const;
  }
  async probe(request: { connectionId: string; sourceId?: string }) {
    this.probes += 1;
    const key = `${request.connectionId}/${request.sourceId ?? ""}`;
    const failure = this.errors[key];
    if (failure) throw failure;
    return this.results[key] ?? { allowed: false, title: "", url: "" };
  }
}

describe("retrieve", () => {
  it("returns only what the source confirmed", async () => {
    const store = new FakeStore([hit("readable", "h1", 0.9), hit("restricted", "h2", 0.8)]);
    const prober = new FakeProber(
      { "c/readable": { allowed: true, title: "Readable", url: "u1", version: "v1" } },
      { "c/restricted": new PermissionDeniedError("403") },
    );

    const outcome = await retrieve([store], prober, "q", ["reader"], 5);

    expect(outcome.chunks).toHaveLength(1);
    // The title came from the probe, not the mirror's "MIRROR TITLE".
    expect(outcome.chunks[0].title).toBe("Readable");
    expect(outcome.denied).toBe(1);
  });

  it("over-fetches so probe drops do not starve the answer", async () => {
    const many = Array.from({ length: 12 }, (_, i) => hit(`s${i}`, `h${i}`, (12 - i) / 12));
    const results: Record<string, ProbeResult> = {};
    for (let i = 0; i < 12; i += 1) {
      results[`c/s${i}`] = { allowed: true, title: "t", url: "u", version: "v1" };
    }
    const prober = new FakeProber(results);

    const outcome = await retrieve([new FakeStore(many)], prober, "q", ["reader"], 4, 3);

    expect(outcome.chunks).toHaveLength(4);
    expect(prober.probes).toBe(12);
  });

  it("falls back to the default multiplier for a nonsense one", async () => {
    const prober = new FakeProber({ "c/s": { allowed: true, title: "t", url: "u", version: "v1" } });
    const outcome = await retrieve([new FakeStore([hit("s", "h", 0.5)])], prober, "q", ["reader"], 2, 0);
    expect(outcome.chunks).toHaveLength(1);
  });

  it("carries both kinds of missing evidence", async () => {
    const healthy = new FakeStore([hit("busy", "h", 0.5)]);
    const broken = new FakeStore([], new Error("qdrant down"));
    const prober = new FakeProber({}, { "c/busy": new TransientProbeError("429") });

    const outcome = await retrieve([healthy, broken], prober, "q", ["reader"], 5);

    // A corpus that could not be searched and a source that could not be
    // checked are different failures, and an answer should be able to say both.
    expect(outcome.skippedCorpora).toBe(1);
    expect(outcome.undetermined).toEqual(["c/busy"]);
    expect(outcome.chunks).toEqual([]);
  });
});

describe("BrokerProber", () => {
  it("authenticates itself and forwards the user's own credential", async () => {
    const http = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ allowed: true, title: "Auth design", url: "https://wiki/1", version: "v7" }),
    } as unknown as Response);

    const prober = new BrokerProber({
      baseUrl: "http://broker",
      token: "orch-token",
      delegatedToken: "user-token",
      fetchImpl: http as unknown as typeof fetch,
    });

    const result = await prober.probe({ connectionId: "snc-confluence", sourceId: "page-1" });

    expect(result.title).toBe("Auth design");
    const [url, init] = http.mock.calls[0]!;
    expect(url).toBe("http://broker/connections/snc-confluence/probe");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer orch-token",
      "x-delegated-token": "user-token",
    });
  });

  it.each([
    [403, "denied"],
    [404, "denied"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
  ])("classifies %i as %s", async (status, kind) => {
    const http = vi.fn().mockResolvedValue({ ok: false, status } as unknown as Response);
    const prober = new BrokerProber({
      baseUrl: "http://broker",
      token: "t",
      delegatedToken: "u",
      fetchImpl: http as unknown as typeof fetch,
    });

    const expected = kind === "denied" ? PermissionDeniedError : TransientProbeError;
    await expect(prober.probe({ connectionId: "c", sourceId: "s" })).rejects.toBeInstanceOf(expected);
  });

  it("refuses to probe without a delegated credential", async () => {
    const prober = new BrokerProber({ baseUrl: "http://broker", token: "t" });
    await expect(prober.probe({ connectionId: "c", sourceId: "s" })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("treats an unreachable broker as transient, not a denial", async () => {
    const http = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const prober = new BrokerProber({
      baseUrl: "http://broker",
      token: "t",
      delegatedToken: "u",
      fetchImpl: http as unknown as typeof fetch,
    });

    await expect(prober.probe({ connectionId: "c", sourceId: "s" })).rejects.toBeInstanceOf(
      TransientProbeError,
    );
  });

  it("defaults an unknown provider to per-resource probing", () => {
    const prober = new BrokerProber({
      baseUrl: "http://broker",
      token: "t",
      granularities: new Map([["slack-eng", "connection" as const]]),
    });

    expect(prober.granularity("slack-eng")).toBe("connection");
    // Assuming per-connection would let one allowed resource vouch for every
    // other candidate from that source.
    expect(prober.granularity("something-new")).toBe("resource");
  });
});
