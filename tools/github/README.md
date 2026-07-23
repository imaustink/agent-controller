# github

A self-contained subagent container: a single allowlisted `gh` (GitHub CLI)
command in, `gh`'s own output out -- authenticated as the **calling user's
own** delegated GitHub token, not a shared bot credential (ADR 0022/0027).

## Contract

- **Input** (`argv[2]`): everything after `gh`, e.g.
  `"issue view 86 --repo imaustink/agent-controller --json title,body"`.
- **Output**: `gh`'s own stdout, wrapped in a fenced code block (`json` when
  `--json` was requested, `text` otherwise), delivered via the event contract
  in [docs/messaging.md](../../docs/messaging.md).

## Identity: acts as the calling user, not a shared bot

Unlike a tool with a static `GITHUB_TOKEN` baked into its Secret, this tool
is designed to run with **`Tool.spec.identityProviders: [github]`** set (see
`charts/community-components/templates/tool-github.yaml`). When a Skill
routes a call to this tool, `agent-orchestrator`'s `runTool` (`graph.ts`)
checks the calling user's own linked GitHub identity via
`apps/integration-gateway`'s identity-link API (the same OAuth Device Flow
broker `opencode-swe-agent` uses, ADR 0022) and injects the resulting token
as a per-invocation `GITHUB_TOKEN` through `ToolRunSpec.secretEnv` (ADR
0025) -- never embedding it in the `ToolRun` CR itself, and never sharing
one credential across every caller. A caller who hasn't linked their GitHub
account yet gets a clear error asking them to link it via a direct
conversation with an identity-linking-capable agent first (v1 scope cut:
this tool's call path cannot itself start a fresh device-flow link -- only
the peer-level agent-delegation path can, see `graph.ts`'s `runTool`
comment).

A `GITHUB_TOKEN`/`GH_TOKEN` env var is all `gh` needs to authenticate --
`src/github.ts` sets both directly on the child process so `gh` never has
to run `gh auth login` or write anything to a persisted config (its
`GH_CONFIG_DIR` is pointed at the container's writable `/tmp`, wiped every
run).

## Safety model (defense in depth)

1. **The calling user's own GitHub permissions are the primary boundary.**
   Because this tool authenticates as a specific, identity-linked human
   (not a broadly-scoped shared bot/App-installation token), the blast
   radius of anything it does is already bounded by what that person is
   actually allowed to do on GitHub -- the same posture as
   `opencode-swe-agent` (see `docs/security.md`'s "opencode-swe-agent: a
   deliberately privileged agent" section, ADR 0022).
2. **In-process command allowlist** (`src/allowlist.ts`) -- an explicit
   allowlist of top-level `gh` commands + subcommands (`issue`, `pr`,
   `repo view/list/clone`, `release view/list`, `gist`, `label`, `search`,
   `workflow view/list`, `run view/list/watch/download`). `auth`, `api`,
   `config`, `secret`, `variable`, `ssh-key`, `gpg-key`, `codespace`,
   `extension`, `alias`, `completion`, and `browse` are excluded entirely
   (see the file header for why each is out of scope for this tool), and a
   handful of individually irreversible-ish subcommands (`repo delete`,
   `issue delete`/`transfer`, `release delete`, `workflow run`, `run
   cancel`/`rerun`, `label delete`) are excluded even within an otherwise
   allowed command. Unlike `tools/kubectl-readonly`'s allowlist, flags/
   values are **not** additionally restricted here -- see the rationale in
   `src/allowlist.ts`'s header comment (this tool's ServiceAccount/RBAC
   grants nothing broader than a fixed set of GitHub permissions; GitHub's
   own authorization on the delegated token is what actually gates a
   write).
3. **No shell** -- the validated argv is passed straight to
   `child_process.spawn`, never interpolated into a shell string
   (`src/github.ts`).
4. **No persisted credentials** -- `GH_CONFIG_DIR` is pointed at `/tmp`
   (wiped every run, root filesystem is otherwise read-only); the token
   only ever lives in this process's env, sourced from
   `ToolRunSpec.secretEnv` (a per-run k8s Secret, garbage-collected with
   the `ToolRun`), never written to disk.
5. **Redaction** (`src/security/redact.ts`) -- GitHub's own token prefixes
   (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`) plus generic `Bearer`/`token `
   patterns are stripped from anything that could reach a `progress`/
   `failed` event message, in case `gh`'s own error text ever echoes back
   part of what it was given.

## Local development

```sh
npm install
npm run typecheck --workspace=github
npm run test --workspace=github
npm run build --workspace=github
docker build -f tools/github/Dockerfile -t github:latest .
GITHUB_TOKEN=ghp_your_pat ./tools/github/run.sh "issue view 86 --repo imaustink/agent-controller"
```

To test the actual identity-delegation path end-to-end, enable
`githubTool.enabled=true` (and `githubTool.identityLink.enabled=true`) in
`charts/community-components`, alongside `identityLink.enabled=true` on both
`agent-orchestrator` and `integration-gateway` (see
`charts/agent-controller/values-production.yaml`), and invoke it as a real
`ToolRun`/Job in a cluster (e.g. minikube) after linking a GitHub account
via chat.
