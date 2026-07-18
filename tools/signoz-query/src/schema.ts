import { z } from "zod";

/** A single equality/inclusion filter on a log/trace attribute. */
export const FilterSchema = z.object({
  key: z.string().min(1),
  op: z.enum(["=", "!=", "contains", "in"]),
  value: z.union([z.string(), z.array(z.string())]),
});
export type Filter = z.infer<typeof FilterSchema>;

/**
 * The simplified, LLM-facing query contract this tool accepts (argv[2], one
 * JSON object). Deliberately narrower than SigNoz's own v3 query_range
 * request body -- the orchestrator's planner constructs this shape directly
 * from the Skill's markdown guidance, and src/signoz.ts maps it onto the
 * real API payload, so no query-building reasoning needs a second LLM call
 * inside this container.
 */
export const QuerySchema = z
  .object({
    signal: z.enum(["logs", "traces", "metrics"]),
    /** Relative ("-1h", "-15m") or ISO-8601 absolute. */
    start: z.string().min(1),
    /** Relative ("now") or ISO-8601 absolute. */
    end: z.string().min(1),
    serviceName: z.string().min(1).optional(),
    /** Required when signal === "metrics". */
    metricName: z.string().min(1).optional(),
    filters: z.array(FilterSchema).max(10).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .refine((q) => q.signal !== "metrics" || !!q.metricName, {
    message: "metricName is required when signal is \"metrics\"",
    path: ["metricName"],
  });
export type Query = z.infer<typeof QuerySchema>;

/** Failure taxonomy for `failed` events. */
export type ErrorCode = "usage" | "invalid_query" | "signoz_error" | "general";

/** Pipeline stages surfaced in `progress` events. */
export type Stage = "validate" | "query";
