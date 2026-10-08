import { z } from "zod";

/**
 * Reference to a large or binary payload delivered out-of-band (object store,
 * mounted volume, etc.). Bytes never travel on the event channel — only this
 * reference does, so the parent can fetch and verify by hash.
 */
export const ArtifactRefSchema = z.object({
  uri: z.string(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  content_type: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
