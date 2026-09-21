import { describe, expect, it, vi } from "vitest";
import { QdrantCorpusWriter, type Embedder, type QdrantLike } from "./corpus-writer.js";
import { corpusPointId } from "./point-id.js";
import type { Chunk } from "./chunk.js";

const COLLECTION = "corpus-default-snc-confluence";

function chunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    connectionId: "snc-confluence",
    connectionLabel: "SNC Confluence",
    sourceId: "12345",
    sourceUrl: "https://wiki.at.bitovi.com/wiki/spaces/SNC/pages/12345",
    title: "Auth design",
    updatedAt: "2026-09-01T10:00:00Z",
    version: "7",
    contentHash: "hash-a",
    text: "We use OIDC.",
    ...overrides,
  };
}

function fakeQdrant(overrides: Partial<QdrantLike> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    createCollection: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
    ...overrides,
  } satisfies QdrantLike;
}

const embedder = (dims = 3): Embedder => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => Array(dims).fill(0.1))),
});

function writer(client: QdrantLike, embed: Embedder = embedder()) {
  return new QdrantCorpusWriter(client, embed, { allowedRoles: ["reader"], vectorSize: 3 });
}

describe("the payload the Temporal engine reads", () => {
  it("writes exactly the fields the Go reader expects", async () => {
    const client = fakeQdrant();
    await writer(client).upsert(COLLECTION, [chunk()]);

    const [, args] = client.upsert.mock.calls[0]!;
    const [point] = args.points;
    // engines/temporal/internal/vectorstore/qdrant.go reads these five keys.
    // An extra key is harmless; a missing or renamed one is a silent read of
    // undefined on the other side.
    expect(Object.keys(point!.payload).sort()).toEqual([
      "descriptor",
      "hidden",
      "id",
      "roles",
      "unrestricted",
    ]);
    expect(point!.payload.id).toBe("hash-a");
    expect(point!.payload.roles).toEqual(["reader"]);
  });

  it("encodes the descriptor as a JSON STRING, not an object", async () => {
    const client = fakeQdrant();
    await writer(client).upsert(COLLECTION, [chunk()]);

    const { payload } = client.upsert.mock.calls[0]![1].points[0]!;
    // Go stores `string(r.Descriptor)` and decodes it back out. An object here
    // would round-trip through Qdrant fine and fail to decode on read.
    expect(typeof payload.descriptor).toBe("string");
  });

  it("writes the descriptor keys corpus.Chunk declares", async () => {
    const client = fakeQdrant();
    // Fully populated: absent optional fields are dropped by JSON.stringify,
    // which is the behaviour we want and would otherwise hide a missing key.
    await writer(client).upsert(COLLECTION, [
      chunk({ aclPrincipals: ["user:acc-1"], aclPermissive: false }),
    ]);

    const { payload } = client.upsert.mock.calls[0]![1].points[0]!;
    // These are the json tags on corpus.Chunk. Provenance is not optional:
    // a chunk that reaches the planner without sourceUrl cannot be cited.
    expect(Object.keys(JSON.parse(payload.descriptor as string)).sort()).toEqual([
      "aclPermissive",
      "aclPrincipals",
      "connectionId",
      "connectionLabel",
      "contentHash",
      "sourceId",
      "sourceUrl",
      "text",
      "title",
      "updatedAt",
      "version",
    ]);
  });

  it("mirrors the ACL even though nothing reads it yet", async () => {
    const client = fakeQdrant();
    await writer(client).upsert(COLLECTION, [
      chunk({ aclPrincipals: ["user:acc-1"], aclPermissive: false }),
    ]);

    // corpus.Chunk has no field for these, so Go ignores them today. Dropping
    // them would discard permission data the driver already paid an API call
    // for, and recovering it later means re-embedding every corpus.
    const { payload } = client.upsert.mock.calls[0]![1].points[0]!;
    expect(JSON.parse(payload.descriptor as string).aclPrincipals).toEqual(["user:acc-1"]);
  });

  it("never marks a corpus point unrestricted", async () => {
    const client = fakeQdrant();
    await writer(client).upsert(COLLECTION, [chunk()]);

    const { payload } = client.upsert.mock.calls[0]![1].points[0]!;
    // `unrestricted` bypasses the role filter entirely. A corpus point is
    // client material; the permissive case is granting roles widely, not
    // opting out of the check.
    expect(payload.unrestricted).toBe(false);
  });

  it("derives point ids the engine can also derive", async () => {
    const client = fakeQdrant();
    await writer(client).upsert(COLLECTION, [chunk({ contentHash: "abc123" })]);

    expect(client.upsert.mock.calls[0]![1].points[0]!.id).toBe(
      corpusPointId(COLLECTION, "abc123"),
    );
  });
});

describe("upsert", () => {
  it("does nothing when there is nothing to write", async () => {
    const client = fakeQdrant();
    await writer(client).upsert(COLLECTION, []);

    // Qdrant 400s on an empty update, and "nothing changed" is the normal
    // outcome of reconciling an unedited space.
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("embeds in ONE call for the whole batch", async () => {
    const client = fakeQdrant();
    const embed = embedder();
    await writer(client, embed).upsert(COLLECTION, [chunk(), chunk({ contentHash: "b" })]);

    expect(embed.embed).toHaveBeenCalledTimes(1);
  });

  it("refuses to write when the embedder returns the wrong number of vectors", async () => {
    const client = fakeQdrant();
    const broken: Embedder = { embed: async () => [[0.1, 0.1, 0.1]] };

    // Zipping by index would silently pair each chunk with another chunk's
    // embedding — every retrieval wrong, nothing erroring.
    await expect(
      writer(client, broken).upsert(COLLECTION, [chunk(), chunk({ contentHash: "b" })]),
    ).rejects.toThrow(/would pair chunks with other chunks/);
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it("waits for the write to land", async () => {
    const client = fakeQdrant();
    await writer(client).upsert(COLLECTION, [chunk()]);

    // Without this the next reconcile can read a stale view of what is indexed
    // and delete what it just wrote.
    expect(client.upsert.mock.calls[0]![1].wait).toBe(true);
  });

  it("creates the collection on first write", async () => {
    const client = fakeQdrant({ collectionExists: vi.fn().mockResolvedValue(false) });
    await writer(client).upsert(COLLECTION, [chunk()]);

    // Cosine and a shared size are what make scores comparable across the
    // members of one knowledge base.
    expect(client.createCollection).toHaveBeenCalledWith(COLLECTION, {
      vectors: { size: 3, distance: "Cosine" },
    });
  });
});

describe("indexed", () => {
  it("reads every page, not just the first", async () => {
    const point = (hash: string) => ({
      payload: { id: hash, descriptor: JSON.stringify({ sourceId: "doc-1" }) },
    });
    const client = fakeQdrant({
      scroll: vi
        .fn()
        .mockResolvedValueOnce({ points: [point("a")], next_page_offset: "cursor-1" })
        .mockResolvedValueOnce({ points: [point("b")], next_page_offset: null }),
    });

    const indexed = await writer(client).indexed(COLLECTION);

    // A partial read presents surviving chunks as absent, and on a full pass
    // reconcile deletes what it believes is absent.
    expect(indexed.map((c) => c.contentHash)).toEqual(["a", "b"]);
  });

  it("asks for no vectors, which are the bulk of a point", async () => {
    const client = fakeQdrant();
    await writer(client).indexed(COLLECTION);

    expect(client.scroll.mock.calls[0]![1].with_vector).toBe(false);
  });

  it("skips a point whose id cannot be read rather than guessing", async () => {
    const client = fakeQdrant({
      scroll: vi.fn().mockResolvedValue({
        points: [{ payload: { descriptor: "{}" } }, { payload: null }],
        next_page_offset: null,
      }),
    });

    expect(await writer(client).indexed(COLLECTION)).toEqual([]);
  });

  it("still reports a point whose descriptor will not parse", async () => {
    const client = fakeQdrant({
      scroll: vi.fn().mockResolvedValue({
        points: [{ payload: { id: "a", descriptor: "not json" } }],
        next_page_offset: null,
      }),
    });

    // The point is real and owned by this collection; reconcile keys deletion
    // on the hash, so losing the sourceId costs nothing it needs.
    expect(await writer(client).indexed(COLLECTION)).toEqual([{ contentHash: "a", sourceId: "" }]);
  });
});

describe("remove", () => {
  it("deletes by the same derived point id it wrote", async () => {
    const client = fakeQdrant();
    await writer(client).remove(COLLECTION, ["abc123"]);

    // A mismatch here does not error — it just stops deleting, and the corpus
    // fills with chunks no source still has.
    expect(client.delete).toHaveBeenCalledWith(COLLECTION, {
      wait: true,
      points: [corpusPointId(COLLECTION, "abc123")],
    });
  });

  it("does nothing when there is nothing to remove", async () => {
    const client = fakeQdrant();
    await writer(client).remove(COLLECTION, []);
    expect(client.delete).not.toHaveBeenCalled();
  });
});
