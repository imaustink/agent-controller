import { z } from "zod";
import {
  NoteCreate,
  NoteGet,
  NoteSearch,
  NoteUpdate,
  TaskCreate,
  TaskGet,
  TaskSearch,
  TaskUpdate,
  type GlyphCommand,
} from "./schema.js";

/** Raised when the input isn't a valid Glyph command. Carries a user-facing message. */
export class CommandError extends Error {}

/**
 * The (resource, action) → schema dispatch table. Two-level discrimination
 * (a note vs a task, and which of the four operations) is clearer as an
 * explicit lookup than a nested zod union — and it lets a wrong pair produce
 * a targeted "unknown resource/action" message instead of a wall of union
 * branch errors.
 */
const SCHEMAS = {
  note: { create: NoteCreate, get: NoteGet, update: NoteUpdate, search: NoteSearch },
  task: { create: TaskCreate, get: TaskGet, update: TaskUpdate, search: TaskSearch },
} as const;

const RESOURCES = Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[];
const ACTIONS = ["create", "get", "update", "search"] as const;

/** The envelope every command shares — validated first so a bad resource/action is reported precisely. */
const EnvelopeSchema = z.object({
  resource: z.enum(RESOURCES as [keyof typeof SCHEMAS, ...(keyof typeof SCHEMAS)[]]),
  action: z.enum(ACTIONS),
});

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("; ");
}

/**
 * Parses and validates the tool's single-string JSON input into a typed
 * command. Throws {@link CommandError} with an actionable message on anything
 * malformed, so index.ts can surface it as a clean `invalid_input` failure
 * (never a raw stack trace).
 */
export function parseCommand(raw: string): GlyphCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CommandError(
      'Input must be a JSON object, e.g. {"resource":"task","action":"create","title":"..."}',
    );
  }

  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new CommandError(
      `Input must name a resource (${RESOURCES.join("/")}) and action (${ACTIONS.join("/")}): ` +
        formatZodError(envelope.error),
    );
  }

  const schema = SCHEMAS[envelope.data.resource][envelope.data.action];
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new CommandError(
      `Invalid ${envelope.data.resource} ${envelope.data.action} command: ${formatZodError(result.error)}`,
    );
  }
  return result.data as GlyphCommand;
}
