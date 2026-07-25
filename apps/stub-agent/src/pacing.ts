/**
 * How long a stub turn takes, and whether it narrates while it does.
 *
 * The stub replies instantly by default, which makes it useless for the one
 * class of behaviour that needs a turn still in flight when something else
 * happens to the cluster: an orchestrator rollout, a NATS bounce, or a silence
 * long enough to trip the idle window. These knobs open that window.
 *
 * Kept out of index.ts so the parsing is unit-testable without a NATS
 * connection, matching reply.ts.
 */
export interface StubPacing {
  /**
   * Emit a progress message every `narrateEveryMs` for this long before
   * replying. Narration RESETS the orchestrator's idle window, so a turn paced
   * this way must survive regardless of how far it exceeds that window.
   */
  narrateForMs: number;
  /** Cadence of the narration above. */
  narrateEveryMs: number;
  /**
   * Say NOTHING for this long before replying (after any narration phase).
   * Exceeding the orchestrator's idle window here must fail the turn — that is
   * the behaviour the window exists for, and it silently did not work at all
   * before (the bound was a nats.js first-message timeout, cancelled by the
   * stub's own first progress message).
   */
  silentForMs: number;
}

/** Upper bound on any single knob, so a typo cannot hang a suite for hours. */
const MAX_MS = 10 * 60 * 1000;

function ms(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, MAX_MS);
}

export function readPacing(env: NodeJS.ProcessEnv): StubPacing {
  return {
    narrateForMs: ms(env.STUB_NARRATE_FOR_MS, 0),
    narrateEveryMs: ms(env.STUB_NARRATE_EVERY_MS, 2000) || 2000,
    silentForMs: ms(env.STUB_SILENT_FOR_MS, 0),
  };
}

/** True when the stub should behave exactly as it did before these knobs existed. */
export function isImmediate(p: StubPacing): boolean {
  return p.narrateForMs === 0 && p.silentForMs === 0;
}
