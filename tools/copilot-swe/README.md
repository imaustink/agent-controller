# copilot-swe

A **privileged** subagent container that performs software-engineering tasks on
GitHub end-to-end using the agentic [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli).
An instruction goes in; a pull request comes out.

Like the other `tools/*` containers it is one-shot (launched as a k8s Job by
the tool-controller, ADR 0010) and reports over the shared
`@recipe-agent/messaging` callback protocol. Unlike them it is deliberately
more privileged — see [../../docs/security.md](../../docs/security.md).

## What it does

1. Mints a short-lived **GitHub App installation token** from the App id +
   private key. This authenticates all `git`/`gh` operations and bounds which
   repositories the tool can touch (to the App's installations).
2. Runs the **Copilot CLI** headless (`copilot -p … --allow-all-tools
   --no-ask-user`) in a writable workspace, driving `git` and `gh` itself to
   create/clone a repo, branch, commit, push, and open a pull request.
3. Reports a summary + the PR link, prefixed with an `<!-- swe: … -->` marker
   so a follow-up turn continues the same pull request.

## Two credentials (on purpose)

| Purpose | Credential | Env var |
| --- | --- | --- |
| Copilot **model** access | Fine-grained (v2) PAT with the **Copilot Requests** permission, from a Copilot-subscribed account (classic `ghp_` not accepted) | `COPILOT_GITHUB_TOKEN` |
| **git / GitHub** operations | A **GitHub App** (id + private key) → installation token, minted at run time | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, optional `GITHUB_APP_INSTALLATION_ID` |

Keeping them separate is why the built-in Copilot GitHub MCP server is disabled
(`--disable-builtin-mcps`): git auth uses the App token via `GH_TOKEN`, model
auth uses the Copilot PAT.

## Guardrails (no irreversible actions)

Defense in depth — no single layer is sufficient:

- **Copilot deny rules** baked into every run (`src/copilot.ts`, `DENY_TOOLS`):
  force-push variants, `git reset --hard`, branch/ref deletion, `rm -rf`,
  `gh repo delete`, `gh api -X DELETE`. Deny rules always win, even under
  `--allow-all-tools`.
- **GitHub App permissions**: grant only Contents/Pull requests/Metadata (plus
  Administration only if repo creation is needed). Installation scope bounds
  the blast radius.
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
| 3 | GitHub App authentication failure |
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
