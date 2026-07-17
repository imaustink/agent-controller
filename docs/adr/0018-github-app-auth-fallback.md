# 0018. Optional GitHub App auth for opencode-swe-agent, falling back to the PAT

Status: accepted

## Context

`opencode-swe-agent` authenticates all `git`/`gh` operations with a single
static, long-lived fine-grained PAT (`GITHUB_TOKEN`; see
[ADR 0016](0016-opencode-anthropic-direct-swe-agent.md)). [ADR
0013](0013-copilot-swe-privileged-coding-tool.md) had considered a GitHub App
instead, for per-repo installation governance and short-lived tokens, but
rejected it: the Copilot CLI's *model* auth also needed a GitHub credential,
so an App installation token (which can't authenticate the Copilot model)
would have forced a second credential for no benefit.

0016 already removed that constraint — the model now authenticates via a
plain `ANTHROPIC_API_KEY`, fully independent of the GitHub credential. Nothing
about the git/gh side changed at the time, but it left the door open for a
GitHub App to cover just that half. `src/schema.ts`'s `SweErrorCode` doc
comment and `src/security/redact.ts`'s secret patterns (a PEM-private-key
pattern and a compact-JWT pattern, both called out as covering "the GitHub
App's private key" / "the App JWT used to mint installation tokens") already
anticipated this before any App code existed.

## Decision

Add GitHub App authentication as an **alternative to, not a replacement for**,
the existing PAT — existing PAT-only deployments keep working unmodified.

1. **New module `src/githubApp.ts`.** `signAppJwt` builds an RS256 App JWT by
   hand with `node:crypto`'s `createSign` (no new dependency); `iat` is
   backdated 60s for clock drift and `exp` sits at GitHub's 10-minute cap.
   `mintInstallationToken` POSTs that JWT to
   `POST /app/installations/{id}/access_tokens` and returns the short-lived
   (~1h) installation token.
2. **Three new optional env vars**: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
   `GITHUB_APP_INSTALLATION_ID` (`src/config.ts`), read alongside the existing
   `GITHUB_TOKEN`. `GITHUB_APP_PRIVATE_KEY` is normalized to handle either
   real newlines or `\n`-escaped PEM (both show up depending on how the k8s
   Secret was created).
3. **Precedence, resolved once per run in `resolveGithubToken`
   (`src/githubApp.ts`)**: if all three App env vars are set, mint an
   installation token and use it for the whole run (each `AgentRun` is a
   fresh Job/process per 0013's branch-as-state design, so one mint at
   startup covers the run — no mid-run refresh needed within the ~1h token
   lifetime and the agent's own timeout). Otherwise fall back to the static
   `GITHUB_TOKEN`. A **partial** App configuration (1 or 2 of the 3 fields
   set) is rejected outright rather than silently falling back to the PAT,
   since that's almost certainly a typo'd Secret rather than an intentional
   choice.
4. **No changes needed to `security/redact.ts`**: its existing patterns
   (PEM private key, compact JWT, `gh[opsu]_...`/`ghs_...` tokens) already
   cover the App private key, the App JWT, and installation tokens.
5. **`index.ts`** calls `resolveGithubToken(toolConfig)` once at the top of
   the run instead of reading `toolConfig.githubToken` directly; the rest of
   the pipeline (`setupGitAuth`, `GH_TOKEN`/`GITHUB_TOKEN` child-process env)
   is unchanged — it just receives whichever token was resolved.

## Consequences

- Operators can now scope credentials per-repo via an App installation
  instead of hand-scoping a fine-grained PAT, and tokens auto-expire in ~1h
  instead of living until manually rotated — better for the "no irreversible
  actions" defense-in-depth posture described in
  [docs/security.md](../security.md), though the PAT path's other mitigations
  (deny rules, branch protection) are unchanged and still required either way.
- `opencode-swe-secrets` gains three optional keys
  (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`/`GITHUB_APP_INSTALLATION_ID`);
  existing PAT-only secrets need no changes.
- One additional GitHub API round-trip (JWT -> installation token exchange)
  at the start of each run when App auth is configured; negligible next to
  the run's overall duration.
