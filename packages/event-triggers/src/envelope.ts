// Envelope construction for integration-gateway (docs/event-triggers.md §2).

import { randomUUID } from "node:crypto";
import type { Envelope, EnvelopeSender } from "./types.js";
import { setOwn, type JsonValue } from "./values.js";

/** Always removed from envelope headers, in addition to the verify header. */
export const ALWAYS_DROPPED_HEADERS: readonly string[] = ["authorization", "cookie"];

export type RawHeaders = Readonly<Record<string, string | readonly string[] | number | undefined>>;

/**
 * Lower-cases header names, joins repeated values (arrays, or names differing
 * only in case) with ", ", and removes authorization, cookie and `dropNames`
 * (case-insensitive).
 */
export function normalizeHeaders(rawHeaders: RawHeaders, dropNames: Iterable<string> = []): Record<string, string> {
  const drop = new Set(ALWAYS_DROPPED_HEADERS);
  for (const n of dropNames) if (n) drop.add(n.toLowerCase());
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (drop.has(name)) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    const prev = Object.prototype.hasOwnProperty.call(out, name) ? out[name] : undefined;
    setOwn(out, name, prev === undefined ? value : `${prev}, ${value}`);
  }
  return out;
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Parses a request body per §2: `application/json` → the parsed JSON;
 * `application/x-www-form-urlencoded` → an object of string fields (the first
 * value wins for a repeated key); anything else — including JSON that does
 * not parse — → `{"text": "<raw utf-8>"}`.
 */
export function parseBody(rawBody: Buffer | Uint8Array, contentType?: string): JsonValue {
  const text = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength).toString("utf8");
  const type = mediaType(contentType);
  if (type === "application/json") {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return { text };
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of new URLSearchParams(text)) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) setOwn(out, k, v);
    }
    return out;
  }
  return { text };
}

/** RFC 3339 UTC, second precision ("2026-10-13T12:00:00Z"). */
export function formatEventTime(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface WebhookEnvelopeInput {
  source: string;
  /** deliveryIdHeader value; a random uuid when absent/empty. */
  id?: string;
  /** Already normalized (see normalizeHeaders). */
  headers: Record<string, string>;
  body: JsonValue;
  sender?: EnvelopeSender;
  repository?: string;
  now: Date;
}

export function buildWebhookEnvelope(input: WebhookEnvelopeInput): Envelope {
  return {
    source: input.source,
    kind: "webhook",
    id: input.id ? input.id : randomUUID(),
    time: formatEventTime(input.now),
    headers: { ...input.headers },
    body: input.body,
    sender: input.sender ? { ...input.sender } : {},
    repository: input.repository ?? "",
  };
}

export interface CronEnvelopeInput {
  source: string;
  /** spec.cron.payload; `{}` when absent. */
  payload?: JsonValue;
  now: Date;
}

export function buildCronEnvelope(input: CronEnvelopeInput): Envelope {
  return {
    source: input.source,
    kind: "cron",
    id: `${input.source}-${Math.floor(input.now.getTime() / 1000)}`,
    time: formatEventTime(input.now),
    headers: {},
    body: input.payload ?? {},
    sender: {},
    repository: "",
  };
}
