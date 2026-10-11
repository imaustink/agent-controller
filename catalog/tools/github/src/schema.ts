/**
 * Failure taxonomy for `failed` events. Mirrors the process exit codes in
 * index.ts so the parent orchestrator can branch on failure class regardless
 * of which transport delivered the event.
 */
export type ErrorCode = "usage" | "blocked_command" | "gh_error" | "general";

/** Pipeline stages surfaced in `progress` events. */
export type Stage = "validate" | "exec";
