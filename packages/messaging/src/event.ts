import { z } from "zod";
import { ArtifactRefSchema, type ArtifactRef } from "./artifact.js";

/**
 * The wire contract for message passing. A single tool call emits an ordered
 * stream: `accepted` → `progress`* / `warning`* → (`succeeded` | `failed`).
 * The same JSON shape is used on every transport (broker message, NDJSON
 * line, or HTTP callback body).
 *
 * This library is deliberately generic: `result` (on `succeeded`) is whatever
 * shape a specific tool produces, and `stage` / `code` are free-form strings
 * a tool defines for its own pipeline and failure taxonomy. Runtime
 * validation here only enforces the envelope *shape* — a tool is expected to
 * validate its own `result` payload (e.g. with its own zod schema) before
 * calling `succeeded()`.
 */

/** Fields present on every event, regardless of `type`. */
const EventBaseSchema = z.object({
  /** Correlation id shared by every event of a single tool call. */
  job_id: z.string(),
  /** Monotonic per-job sequence number; gives ordering and dedupe. */
  seq: z.number().int().nonnegative(),
  /** ISO 8601 emission timestamp. */
  ts: z.string(),
});
type EventBase = z.infer<typeof EventBaseSchema>;

/** Runtime shape validation. `result`/`stage`/`code` are intentionally loose. */
export const EventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("accepted"),
    url: z.string(),
  }),
  EventBaseSchema.extend({
    type: z.literal("progress"),
    stage: z.string(),
    pct: z.number().min(0).max(100).optional(),
    message: z.string().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("warning"),
    message: z.string(),
  }),
  EventBaseSchema.extend({
    type: z.literal("succeeded"),
    result: z.unknown(),
    artifacts: z.array(ArtifactRefSchema).optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal("failed"),
    code: z.string(),
    message: z.string(),
  }),
]);

/**
 * Statically-typed event, parameterized by a tool's `succeeded.result` shape.
 * `stage`/`code` stay plain strings at runtime; tools narrow them with their
 * own string-literal unions via {@link JobEmitter}'s type parameters.
 */
export type Event<TResult = unknown> =
  | (EventBase & { type: "accepted"; url: string })
  | (EventBase & { type: "progress"; stage: string; pct?: number; message?: string })
  | (EventBase & { type: "warning"; message: string })
  | (EventBase & { type: "succeeded"; result: TResult; artifacts?: ArtifactRef[] })
  | (EventBase & { type: "failed"; code: string; message: string });
