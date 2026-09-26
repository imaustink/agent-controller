import { createHash } from "node:crypto";

/**
 * The UUID namespace for URLs (RFC 4122 Appendix C), which is what Go's
 * `uuid.NameSpaceURL` is.
 */
const NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

/**
 * Prefix the Temporal engine derives point ids under.
 *
 * It names that engine even though this file is in the broker, and it must stay
 * that way: it is not a description of who is writing, it is a fixed part of a
 * hash that is already on disk. Changing it to something more accurate would
 * silently orphan every point ever written.
 */
const PREFIX = "github.com/controller-agent/temporal-engine/";

/**
 * Derives a Qdrant point id from a corpus chunk's content hash.
 *
 * Qdrant accepts only an unsigned integer or a UUID as a native point id, so a
 * content hash cannot be used directly; the real id travels in the payload's
 * `id` field, and this is a deterministic function of it.
 *
 * **This is a cross-engine contract, not an implementation detail.** The
 * Temporal engine derives ids the same way in
 * `engines/temporal/internal/vectorstore/qdrant.go` (`pointID`), and whichever
 * process deletes a stale chunk must compute the same UUID as the process that
 * wrote it. The two are verified against each other in point-id.test.ts using
 * values produced by the Go implementation, because "these two functions look
 * equivalent" is not something a reader can check and is exactly the kind of
 * agreement that rots silently — a mismatch does not fail, it just stops
 * deleting anything, and the corpus fills with chunks no source still has.
 *
 * Note this is deliberately NOT the same derivation as the orchestrator's
 * `vector-store/qdrant-id.ts`, which uses a different namespace and does not
 * scope by collection. That one predates the corpus and governs the catalog
 * collections; reusing it here would produce ids the Temporal engine cannot
 * resolve.
 *
 * The collection is part of the hash, so the same chunk indexed under two
 * Connections is two points rather than one shared point that either could
 * delete out from under the other.
 */
export function corpusPointId(collection: string, id: string): string {
  const hash = createHash("sha1")
    .update(Buffer.concat([NAMESPACE_URL, Buffer.from(`${PREFIX}${collection}/${id}`, "utf8")]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
