import { createHash } from "node:crypto";

/**
 * Fixed, arbitrary namespace used to derive Qdrant point ids (RFC 4122 §4.3,
 * UUIDv5) from this app's domain ids (k8s Deployment names, hand-authored
 * skill ids, etc). Qdrant only accepts an unsigned integer or a UUID as a
 * native point id -- arbitrary strings like "recipe-scraper" are rejected
 * with a 400 ("... is not a valid point ID"). The original domain id is kept
 * in each point's payload (`id` field) so callers never see the derived
 * UUID; it only round-trips internally (query/getByIds/delete).
 */
const NAMESPACE = Buffer.from("7b6f1e1a6e6a4f0e9b7a9f2e6b8a2f1a", "hex");

/** Deterministic: the same `id` always maps to the same Qdrant point id. */
export function toQdrantPointId(id: string): string {
  const hash = createHash("sha1")
    .update(Buffer.concat([NAMESPACE, Buffer.from(id, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
