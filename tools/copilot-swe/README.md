# copilot-swe

A **privileged** subagent container that performs software-engineering tasks on
GitHub end-to-end using the agentic [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli).
An instruction goes in; a pull request comes out.

Like the other `tools/*` containers it is one-shot (launched as a k8s Job by
the tool-controller, ADR 0010) and reports over the shared
`@recipe-agent/messaging` callback protocol. Unlike them it is deliberately
more privileged — see [../../docs/security.md](../../docs/security.md).

## What it does

1. Uses a single **fine-grained GitHub PAT** for both Copilot model auth and
   all `git`/`gh` operations (`GH_TOKEN`/`COPILOT_GITHUB_TOKEN` are set to the
   same token).
2. Runs the **Copilot CLI** headless (`copilot -p … --allow-all-tools
   --no-ask-user`) in a writable workspace, driving `git` and `gh` itself to
   create/clone a repo, branch, commit, push, and open a pull request.
3. Reports a summary + the PR link, prefixed with an `<!-- swe: … -->` marker
   so a follow-up turn continues the same pull request.

## Credential & required permissions

One **fine-grained (v2) personal access token** does everything. It must belong
to an account with a **Copilot subscription** and be granted:

| Purpose | Permission | Level |
| --- | --- | --- |
| Copilot model | **Copilot Requests** (account permission) | Read-only |
| clone / push / commit / branches | **Contents** | Read and write |
| open / update pull requests | **Pull requests** | Read and write |
| baseline (auto-selected) | **Metadata** | Read-only |
| create repositories (optional) | **Administration** | Read and write |
| edit `.github/workflows` (optional) | **Workflows** | Read and write |

Also set the token's **repository access** to the specific repos it may touch
(or “All repositories” if it should create new ones). Repo creation with
fine-grained PATs can be finicky — if it fails, create repos manually or scope
the token to an org where it has org **Administration** write.

The token is passed to the Copilot model via `COPILOT_GITHUB_TOKEN` and to git/
`gh` via `GH_TOKEN` (the built-in Copilot GitHub MCP server is disabled with
`--disable-builtin-mcps` so `git`/`gh` are the only GitHub path).

## Guardrails (no irreversible actions)

Defense in depth — no single layer is sufficient:

- **Copilot deny rules** baked into every run (`src/copilot.ts`, `DENY_TOOLS`):
  force-push variants, `git reset --hard`, branch/ref deletion, `rm -rf`,
  `gh repo delete`, `gh api -X DELETE`. Deny rules always win, even under
  `--allow-all-tools`.
- **Least-privilege token**: grant only the permissions above, and scope the
  token's repository access to the intended repos. Note the PAT can reach every
  repo it's granted — a broad token is a broad blast radius.
- **Server-side** branch protection / rulesets on the target repos to block
  force-push and deletion regardless of the client.

## Build & run

```sh
# From the repo root (build context = repo root, for @recipe-agent/messaging):
docker build -f tools/copilot-swe/Dockerfile -t copilot-swe:latest .

# Local test (put credentials in tools/copilot-swe/.env — see .env.example):
./tools/copilot-swe/run.sh 'create a repo hello-svc with a Node HTTP server and open a PR'
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 2 | usage / missing configuration |
| 4 | the Copilot CLI process failed |
| 5 | no pushable result (no repo/branch/PR produced) |
| 1 | general error |

## Deploying

Registered like any other tool via its `Tool` CR (`tool.yaml`) — apply it and
restart the orchestrator (tools load from CRs at startup). Grouped into the
orchestrator's skill layer by
[`apps/agent-orchestrator/config/samples/software-engineering-skill.yaml`](../../apps/agent-orchestrator/config/samples/software-engineering-skill.yaml).

## Known gaps

- **Branch-as-state (Phase A).** Each turn re-clones; durable state lives on the
  pushed branch/PR + the `swe` marker + the orchestrator's conversation-history
  fold. A persistent per-session workspace volume (`--resume`) is a deferred
  enhancement.
- **Result discovery is best-effort**: the tool inspects the produced working
  tree and asks `gh` for an open PR on the branch; if the agent pushed but
  opened no PR, that is reported rather than silently retried.
