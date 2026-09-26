import { describe, expect, it } from "vitest";
import { corpusPointId } from "./point-id.js";

/**
 * These expected values were PRODUCED BY THE GO IMPLEMENTATION
 * (engines/temporal/internal/vectorstore/qdrant.go `pointID`), not by running
 * this function and recording what it said. That distinction is the entire
 * value of the test: it fails if either side drifts, and a hand-rolled UUIDv5
 * that merely looks right would pass a self-recorded fixture forever.
 *
 * Regenerate with a Go program calling
 * `uuid.NewSHA1(uuid.NameSpaceURL, []byte("github.com/controller-agent/temporal-engine/"+collection+"/"+id))`.
 */
const GO_REFERENCE: [collection: string, id: string, expected: string][] = [
  ["corpus-default-globex-confluence", "abc123", "1b0ef555-fa9c-5ea1-8d6d-f8263b11da99"],
  ["corpus-default-globex-confluence", "", "07105c17-a3f8-530e-98d4-3b7d40c9007e"],
  ["other", "abc123", "cff60923-fc57-57dc-b6db-685559bd7f43"],
  // Non-ASCII, to pin UTF-8 encoding rather than assuming it.
  ["c", "ünïcode-✓", "f6f13525-0653-54ae-b6dd-935161d283dc"],
];

describe("corpusPointId", () => {
  it.each(GO_REFERENCE)("matches the Go engine for (%s, %s)", (collection, id, expected) => {
    expect(corpusPointId(collection, id)).toBe(expected);
  });

  it("is a valid RFC 4122 v5 UUID", () => {
    expect(corpusPointId("c", "id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("scopes by collection, so one chunk in two connections is two points", () => {
    // Otherwise either connection's reconcile could delete the other's point.
    expect(corpusPointId("conn-a", "same-hash")).not.toBe(corpusPointId("conn-b", "same-hash"));
  });

  it("is NOT the catalog derivation, which would be unresolvable by the engine", () => {
    // The orchestrator's vector-store/qdrant-id.ts uses a different namespace
    // and ignores the collection entirely. Pinned as a literal rather than
    // imported, because reaching into another workspace's src for a test
    // fixture is how two apps quietly become one.
    //   toQdrantPointId("id") === this value
    expect(corpusPointId("c", "id")).not.toBe("b505be6f-9683-529b-a546-f9cb0c4c059f");
  });
});
