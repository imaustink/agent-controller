import { spawn } from "node:child_process";
import { resolveGithubToken } from "@controller-agent/github-app-auth";
import type { AppConfig } from "./config.js";

export class GhExecError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/**
 * Resolves the token `gh` will authenticate with, before anything is spawned:
 * a GitHub App installation token when the App is fully configured, otherwise
 * the static `GITHUB_TOKEN`/`GH_TOKEN` PAT -- the shared
 * `resolveGithubToken`'s precedence and partial-config rejection verbatim, so
 * every consumer in the repo resolves a GitHub credential the same way.
 *
 * `AppConfig` structurally satisfies `GithubAuthConfig`, so this only exists
 * to translate the shared function's plain `Error`s into {@link GhExecError} --
 * index.ts maps that class to the `gh_error` exit code, and an auth failure
 * should keep reporting as one rather than falling through to `general`.
 *
 * On the coexistence question: `GITHUB_TOKEN` here is normally the CALLING
 * USER's own delegated token (injected per-invocation via
 * `ToolRunSpec.secretEnv`, ADR 0022/0032), so preferring the App over it would
 * mean silently acting as the shared bot instead of the human. That
 * combination is not reachable -- the chart wires the App keys only when
 * identityLink is off, and identity injection only happens when it's on -- and
 * exclusivity is enforced there, in one place, rather than by inverting the
 * precedence here. If App-as-fallback-for-an-unlinked-caller is ever wanted,
 * it needs an explicit signal the way the SWE agents use
 * `GITHUB_IDENTITY_DELEGATION` (see their `isDelegating`), not an implicit
 * ordering that can't tell a per-user token from a static PAT.
 */
export async function resolveToolToken(cfg: AppConfig, now?: number): Promise<string> {
  try {
    return await resolveGithubToken(cfg, now ?? Date.now());
  } catch (err) {
    throw new GhExecError((err as Error).message, "", null);
  }
}

/** Absolute path to the gh binary (see Dockerfile) -- spawned directly, never resolved via PATH. */
const GH_BIN = process.env.GH_BIN ?? "/usr/local/bin/gh";

/**
 * Builds the minimal, explicit env `gh` needs -- never the full inherited
 * process env, so nothing this container itself doesn't need (or scrape
 * from elsewhere) can leak into the child process or its own subrequests.
 * `GH_TOKEN` is `gh`'s own preferred auth env var; `GITHUB_TOKEN` is set
 * too for parity with how other tools in this repo (e.g.
 * apps/opencode-swe-agent) authenticate `gh`, and because some `gh`
 * versions/environments prefer one over the other.
 */
function ghEnv(cfg: AppConfig): NodeJS.ProcessEnv {
  return {
    GH_TOKEN: cfg.githubToken,
    GITHUB_TOKEN: cfg.githubToken,
    GH_HOST: cfg.githubHost,
    // Never write to a persisted config file -- this container's root
    // filesystem is read-only except /tmp (see run.sh's --tmpfs contract).
    GH_CONFIG_DIR: "/tmp/gh-config",
    // Disable interactive prompts and the update-notifier network check --
    // this is a one-shot, non-interactive Job with restricted egress
    // expectations, not an interactive terminal session.
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    HOME: "/tmp",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
}

/**
 * Runs `gh` with the given (already-allowlisted) argv via `spawn` -- never a
 * shell string, so nothing in argv can be reinterpreted as shell syntax.
 * Returns combined stdout on success; throws {@link GhExecError} on a
 * non-zero exit or timeout.
 */
export async function runGh(cfg: AppConfig, argv: string[]): Promise<string> {
  if (!cfg.githubToken) {
    throw new GhExecError("No GitHub token configured (GITHUB_TOKEN/GH_TOKEN both empty)", "", null);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(GH_BIN, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: ghEnv(cfg),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, cfg.ghTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new GhExecError(`gh timed out after ${cfg.ghTimeoutMs}ms`, stderr.trim(), code));
        return;
      }
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new GhExecError(`gh exited with code ${code}`, stderr.trim(), code));
      }
    });
  });
}
