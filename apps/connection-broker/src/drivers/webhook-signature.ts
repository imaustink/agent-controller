import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How far a signed timestamp may be from now.
 *
 * A signature alone does not stop replay: a captured request stays valid
 * forever without this, and replaying a change notification is a cheap way to
 * make the broker spend a client's credential repeatedly. Five minutes is
 * Slack's own recommendation and is generous for clock skew.
 */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Constant-time compare of two hex digests.
 *
 * A plain `===` leaks how much of a prefix matched through timing, which is
 * enough to forge a signature byte by byte given enough attempts.
 */
export function signaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still burn a comparison so a length mismatch is not distinguishable by
    // timing from a content mismatch.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Whether a unix-seconds timestamp is inside the replay window. */
export function withinReplayWindow(timestampSeconds: string | undefined, now: number): boolean {
  if (!timestampSeconds) return false;
  const seconds = Number(timestampSeconds);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(now - seconds * 1000) <= REPLAY_WINDOW_MS;
}
