import { z } from "zod";

/**
 * The tool's input is a free-form natural-language software-engineering
 * instruction (optionally prefixed with a `<!-- swe: ... -->` marker carried
 * forward from a previous turn — see src/marker.ts). There is nothing to
 * structurally validate beyond "non-empty text"; the agent interprets it.
 */
export const InstructionSchema = z.string().min(1, "Instruction must not be empty");

/** Pipeline stages emitted via the messaging protocol (docs/messaging.md). */
export type SweStage = "authenticate" | "prepare" | "agent" | "finalize";

/**
 * Error taxonomy (plain TS union, not runtime-validated — same convention as
 * the other tools in this repo).
 *  - usage:   missing/blank instruction or required configuration
 *  - auth:    GitHub App token minting / Copilot auth failure
 *  - agent:   the Copilot CLI process failed
 *  - git:     no pushable result was produced (no branch/commit/PR)
 *  - general: anything else
 */
export type SweErrorCode = "usage" | "auth" | "agent" | "git" | "general";
