import { z } from "zod";

/**
 * Pipeline stages surfaced in `progress` events (see docs/messaging.md).
 */
export type Stage = "validate" | "request";

/**
 * Failure taxonomy for `failed` events. Mirrors the process exit codes in
 * index.ts so the parent orchestrator can branch on failure class regardless
 * of which transport delivered the event.
 *  - `usage`         — the tool was invoked with no/blank input or missing config.
 *  - `invalid_input` — the JSON command did not match the accepted schema.
 *  - `glyph_error`   — the Glyph API rejected or failed the request.
 *  - `general`       — anything else (unexpected error).
 */
export type ErrorCode = "usage" | "invalid_input" | "glyph_error" | "general";

// ─── Shared value schemas (mirror glyph/api/internal/model/model.go) ──────────

/** Glyph task/page priority. */
export const PrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
export type Priority = z.infer<typeof PrioritySchema>;

/** Glyph task status. */
export const TaskStatusSchema = z.enum(["todo", "in-progress", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

const uuid = z.string().uuid("must be a Glyph resource UUID");
const title = z.string().min(1, "title must not be empty").max(500);
const tags = z.array(z.string().min(1)).max(50);
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dueDate must be an ISO date, YYYY-MM-DD");
const limit = z.number().int().positive().max(200);

// ─── Note commands (a Glyph "note" is a page of type `page`) ──────────────────

export const NoteCreate = z.object({
  resource: z.literal("note"),
  action: z.literal("create"),
  title,
  /** Note body as Markdown; converted to Glyph's ProseMirror content on write. */
  body: z.string().max(500_000).optional(),
  tags: tags.optional(),
  priority: PrioritySchema.optional(),
  /** Optional parent page id, to nest this note under an existing page/folder. */
  parentId: uuid.optional(),
});

export const NoteGet = z.object({
  resource: z.literal("note"),
  action: z.literal("get"),
  id: uuid,
});

export const NoteUpdate = z.object({
  resource: z.literal("note"),
  action: z.literal("update"),
  id: uuid,
  title: title.optional(),
  body: z.string().max(500_000).optional(),
  tags: tags.optional(),
  priority: PrioritySchema.optional(),
});

export const NoteSearch = z.object({
  resource: z.literal("note"),
  action: z.literal("search"),
  /** Case-insensitive substring matched against note titles (and tags). Omit/empty to list all. */
  query: z.string().max(500).optional(),
  limit: limit.optional(),
});

// ─── Task commands ────────────────────────────────────────────────────────────

export const TaskCreate = z.object({
  resource: z.literal("task"),
  action: z.literal("create"),
  title,
  description: z.string().max(10_000).optional(),
  status: TaskStatusSchema.optional(),
  priority: PrioritySchema.optional(),
  dueDate: dueDate.optional(),
  tags: tags.optional(),
});

export const TaskGet = z.object({
  resource: z.literal("task"),
  action: z.literal("get"),
  id: uuid,
});

export const TaskUpdate = z.object({
  resource: z.literal("task"),
  action: z.literal("update"),
  id: uuid,
  title: title.optional(),
  description: z.string().max(10_000).optional(),
  status: TaskStatusSchema.optional(),
  priority: PrioritySchema.optional(),
  dueDate: dueDate.nullable().optional(),
  tags: tags.optional(),
});

export const TaskSearch = z.object({
  resource: z.literal("task"),
  action: z.literal("search"),
  /** Case-insensitive substring matched against task title/description/tags. Omit to match all. */
  query: z.string().max(500).optional(),
  status: TaskStatusSchema.optional(),
  priority: PrioritySchema.optional(),
  limit: limit.optional(),
});

export type NoteCreateCommand = z.infer<typeof NoteCreate>;
export type NoteGetCommand = z.infer<typeof NoteGet>;
export type NoteUpdateCommand = z.infer<typeof NoteUpdate>;
export type NoteSearchCommand = z.infer<typeof NoteSearch>;
export type TaskCreateCommand = z.infer<typeof TaskCreate>;
export type TaskGetCommand = z.infer<typeof TaskGet>;
export type TaskUpdateCommand = z.infer<typeof TaskUpdate>;
export type TaskSearchCommand = z.infer<typeof TaskSearch>;

export type GlyphCommand =
  | NoteCreateCommand
  | NoteGetCommand
  | NoteUpdateCommand
  | NoteSearchCommand
  | TaskCreateCommand
  | TaskGetCommand
  | TaskUpdateCommand
  | TaskSearchCommand;
