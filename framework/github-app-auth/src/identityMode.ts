/**
 * The identity a run acts as on GitHub (docs/adr/0049), decided ONCE by the
 * launching engine's authorization pre-flight and handed to the run as
 * `AGENT_IDENTITY_MODE`:
 *
 * - `agent`: the agent's own credential (the GitHub App, or a static PAT) for
 *   reads and writes. No caller token is involved.
 * - `delegated`: the caller's own token for reads AND writes. Commits and pull
 *   requests are the caller's.
 * - `hybrid`: the caller's token for reads, the App's for writes
 *   (docs/adr/0041).
 *
 * The run switches on the declared mode rather than inferring delegation from
 * which tokens happen to be present: the engine already decided, and an agent
 * that second-guesses it is how a missing token silently became "run as the
 * App" (a wider credential than the one the operator chose).
 */
export const IDENTITY_MODES = ["agent", "delegated", "hybrid"] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

export const IDENTITY_MODE_ENV = "AGENT_IDENTITY_MODE";

/** A run's identity mode cannot be honoured. Fatal before any work starts. */
export class IdentityModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityModeError";
  }
}

export interface IdentityModeInputs {
  /** `AGENT_IDENTITY_MODE` as the run received it; absent or empty if unset. */
  declared?: string;
  /** The caller's GitHub token (`GITHUB_TOKEN`), if the engine injected one. */
  githubToken?: string;
  /** Whether a full GitHub App configuration (id, key, installation) is present. */
  hasAppCredentials: boolean;
}

function isIdentityMode(value: string): value is IdentityMode {
  return (IDENTITY_MODES as readonly string[]).includes(value);
}

/**
 * Resolves the mode this run must act in.
 *
 * Declared: honoured exactly, and refused (never downgraded) when the run
 * lacks what the mode needs. A `delegated`/`hybrid` run without the caller's
 * token must not fall back to the App, whose reach is wider than the caller's.
 *
 * Not declared: a run no pre-flight decided — a nested sub-agent, the agent
 * behind an agent-backed tool, or anything the LangGraph engine launches —
 * keeps the pre-0049 inference. A caller token plus an App configuration is
 * `hybrid`, otherwise `agent`. That is exactly what the deleted
 * `GITHUB_IDENTITY_DELEGATION` flag gated: the charts set it only alongside
 * the `github` identity provider, and never wire a static PAT next to App
 * credentials, so a caller token and App credentials only ever coexist when
 * the flag was on.
 */
export function resolveIdentityMode(inputs: IdentityModeInputs): IdentityMode {
  const declared = (inputs.declared ?? "").trim();
  const hasCallerToken = Boolean(inputs.githubToken);

  if (!declared) {
    return hasCallerToken && inputs.hasAppCredentials ? "hybrid" : "agent";
  }
  if (!isIdentityMode(declared)) {
    throw new IdentityModeError(
      `${IDENTITY_MODE_ENV}="${declared}" is not one of ${IDENTITY_MODES.join(", ")}`,
    );
  }
  if ((declared === "delegated" || declared === "hybrid") && !hasCallerToken) {
    throw new IdentityModeError(
      `${IDENTITY_MODE_ENV}=${declared} acts as the caller, but this run was not given the caller's GITHUB_TOKEN; ` +
        "refusing rather than running with the App's wider credential",
    );
  }
  if (declared === "hybrid" && !inputs.hasAppCredentials) {
    throw new IdentityModeError(
      `${IDENTITY_MODE_ENV}=hybrid writes as the GitHub App, but this run has no GitHub App configuration`,
    );
  }
  return declared;
}

/** Whether a mode reads with the caller's own token. */
export function readsAsCaller(mode: IdentityMode): boolean {
  return mode === "delegated" || mode === "hybrid";
}
