import { spawn } from "node:child_process";
import { mintInstallationToken } from "@controller-agent/github-app-auth";
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
 * Resolves the token `gh` will authenticate with, before anything is spawned.
 *
 * Precedence is deliberately the INVERSE of the SWE agents'
 * `resolveGithubToken` (which prefers the App): for this tool `GITHUB_TOKEN`
 * is normally the CALLING USER's own delegated token, injected per-invocation
 * via `ToolRunSpec.secretEnv` (ADR 0022/0032), and a per-user credential must
 * never be silently downgraded to the shared App installation. So a supplied
 * token always wins; the App is the shared-credential fallback that replaces
 * a static PAT.
 *
 * The chart keeps these mutually exclusive anyway (identityLink wires no
 * static credential at all), so in practice exactly one path is configured --
 * this ordering just makes the overlap safe rather than surprising.
 *
 * A partial App configuration is rejected rather than falling back, matching
 * `resolveGithubToken`'s own contract: 1-2 of the 3 vars is a misconfiguration,
 * not a request for PAT auth.
 */
export async function resolveToolToken(cfg: AppConfig, now: number = Date.now()): Promise<string> {
  const appFieldsSet = [cfg.githubAppId, cfg.githubAppPrivateKey, cfg.githubAppInstallationId].filter(Boolean).length;

  if (appFieldsSet > 0 && appFieldsSet < 3) {
    throw new GhExecError(
      "Partial GitHub App configuration: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID must all be set together",
      "",
      null,
    );
  }

  if (cfg.githubToken) return cfg.githubToken;

  if (appFieldsSet === 3) {
    const { token } = await mintInstallationToken(
      {
        appId: cfg.githubAppId,
        privateKey: cfg.githubAppPrivateKey,
        installationId: cfg.githubAppInstallationId,
      },
      cfg.githubApiUrl,
      now,
    );
    return token;
  }

  throw new GhExecError(
    "No GitHub token configured: set GITHUB_TOKEN/GH_TOKEN (fine-grained PAT, or the per-user token identity linking injects) " +
      "or all of GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID (GitHub App)",
    "",
    null,
  );
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
