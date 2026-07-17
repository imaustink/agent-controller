# 0016. `opencode-swe-agent` calls Anthropic directly, replacing the Copilot CLI

Status: accepted

## Context

The software-engineering sub-agent (`apps/copilot-swe-agent`, see
[0013](0013-copilot-swe-privileged-coding-tool.md)) wrapped the agentic
**GitHub Copilot CLI** (`copilot -p ...`), whose model access is billed and
authenticated through GitHub Copilot rather than a model provider directly.
0013's single-fine-grained-PAT design followed from that: the Copilot CLI
could only authenticate its model via a GitHub credential
(`COPILOT_GITHUB_TOKEN`), so the same PAT was reused for `git`/`gh` operations
too, coupling two conceptually distinct credentials into one.

We want the sub-agent to call **Anthropic directly** (Claude Sonnet 5,
`anthropic/claude-sonnet-5`) instead of going through Copilot's model proxy,
using our own Anthropic API key rather than a GitHub-Copilot-mediated one. The
**opencode** CLI (`opencode-ai` on npm) is an open-source agentic coding CLI
with first-class support for calling model providers (including Anthropic)
directly, a headless `opencode run --format json` mode analogous to
`copilot -p --output-format json`, and a `permission.bash` deny-rule mechanism
analogous to Copilot's `--deny-tool`.

## Decision

Rename `apps/copilot-swe-agent` to `apps/opencode-swe-agent` and swap the
underlying CLI, keeping the same Agent-SDK shape (bidirectional NATS, HITL via
`session.ask()`, the `<!-- swe: ... -->` continuation marker).

1. **Two independent secrets, not one.** Unlike Copilot, opencode's Anthropic
   provider takes a plain `ANTHROPIC_API_KEY` — it has no dependency on a
   GitHub credential. `GITHUB_TOKEN` (git/gh operations) and
   `ANTHROPIC_API_KEY` (the model) are now separate values in the
   `opencode-swe-secrets` k8s Secret, each with its own least-privilege scope.
2. **Headless invocation.** `opencode run <prompt> --auto --dir <workdir>
   --format json [--model <id>]`, mirroring the old `copilot -p` invocation.
   `--auto` auto-approves anything not covered by an explicit permission rule,
   the equivalent of `--allow-all-tools`.
3. **Guardrails via `opencode.json` `permission.bash` deny rules**, written to
   `$XDG_CONFIG_HOME/opencode/opencode.json` before each run (pointed at a
   writable path under the job's `$HOME`, itself under `/tmp`). Deny rules
   (force-push variants, `git reset --hard`, branch/ref deletion, `rm -rf`,
   `gh repo delete`, `gh api -X DELETE`) win over `--auto`, the same
   deny-always-wins guarantee 0013 relied on for Copilot's `--deny-tool`.
4. **Model pinned to `anthropic/claude-sonnet-5`** by default (opencode's
   `provider/model` id format), overridable via `OPENCODE_MODEL` for
   operators who want a different Anthropic model.
5. **Everything else from 0013 is unchanged**: branch-as-state multi-turn, the
   `swe` marker, `tier: privileged`, and the k8s hardening (non-root, read-only
   root filesystem, writable `emptyDir` under `$HOME`).

One area is flagged rather than fully verified: opencode's exact
`--format json` event schema was not confirmed against a first-party spec at
authoring time (opencode is built on the Vercel AI SDK, whose stream-part
shapes are well-known, but opencode's own headless event format wasn't fully
documented in what was available). `src/opencode.ts`'s `parseOpencodeLine` is
written defensively (tries several plausible shapes, falls back to generic
text-bearing keys) the same way the Copilot parser had an "unknown shape"
fallback branch — tighten it against real output once observed.

## Consequences

- The Anthropic API key now bills the owning Anthropic account directly for
  the agent's model usage, instead of being mediated through GitHub Copilot
  billing.
- Credential separation is strictly better for least-privilege: a leaked
  `ANTHROPIC_API_KEY` no longer implies GitHub write access and vice versa
  (0013's single-PAT design no longer applies to this agent).
- Operators upgrading from `copilot-swe-agent` must create the renamed
  `opencode-swe-agent` ServiceAccount and `opencode-swe-secrets` Secret (now
  with both `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` keys) and delete the old
  ones; see `apps/opencode-swe-agent/agent.yaml`.
- The `parseOpencodeLine` progress-narration quality depends on how closely
  the defensive parser matches opencode's real event stream; verify against
  actual `opencode run --format json` output before relying on rich
  progress narration in production.
