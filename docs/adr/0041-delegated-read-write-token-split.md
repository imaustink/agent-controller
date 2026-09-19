# 0041. Reads run as the user, writes run as the App

Status: accepted

## Context

[ADR 0022](0022-per-user-github-device-flow-identity.md) introduced a per-user
GitHub token; [ADR 0029](0029-canonical-github-credential-subject.md) made a
GitHub link the canonical credential subject. Neither changed what credential
`git`/`gh` actually run on. 0029 said so plainly:

> Git operations do not depend on that link — `resolveGithubToken` still
> prefers the App installation token whenever all three App fields are
> configured, so commits keep attributing to the App identity. The per-user
> `GITHUB_TOKEN` the link injects … makes per-user attribution available as a
> later, separate choice.

This is that later choice, plus the half that was missing entirely.

Two problems had accumulated:

1. **Reads were over-privileged.** Every run — clone, fetch, `gh repo list`,
   `gh api` — used the App installation token, which can see every repository
   the App is installed on. Two humans with very different GitHub access got
   identical visibility, and a turn could read a repo the person who asked
   could not.
2. **The authorization check that existed was dead code.**
   `resolveDelegatedWriteToken` (`packages/github-app-auth`) already verified
   the caller's own write permission before minting a repo-scoped App token.
   But `isDelegating()` requires a per-user `GITHUB_TOKEN`, which only exists
   when the Agent declares the `github` provider — and `catalog-values.yaml`
   excludes it deliberately, reasoning that it "would provision a per-user
   `GITHUB_TOKEN` this agent doesn't use." The token was unused *because* it
   was excluded, and the exclusion cited the non-use as its justification.
   Net effect: any chat user could have the bot write to any installed repo,
   with no check that they could write there themselves.

The stated blocker for declaring `github` was spurious `/user` 401s.
[ADR 0030 §5](0030-authorization-preflight-outside-the-llm.md) already removed
the need for that call on one path by passing `AGENT_ACTOR_LOGIN`; it remained
on the known-repo path.

## Decision

**A delegating turn resolves two credentials, not one.**

1. **`resolveDelegatedToken` returns `{ readToken, writeToken, attribution }`.**
   `readToken` is the initiating human's own OAuth token; `writeToken` is an
   App installation token, scoped to the single target repo when one is known.
   The existing permission check and `finalizeDelegatedWrite` post-flight are
   unchanged — they keep running, and now they run at all.

2. **Git splits natively, with no wrapper.** `setupGitAuth` writes
   `url.<base>.insteadOf` with the read token and `url.<base>.pushInsteadOf`
   with the write token. Git resolves `pushInsteadOf` for push URLs and
   `insteadOf` for everything else, so clone and fetch are the user's and the
   push is the App's. A non-delegating run emits no push rewrite and is
   byte-for-byte what it was.

3. **`gh` splits via a generated shim** (`src/ghShim.ts`), because `gh` reads
   one `GH_TOKEN` for every subcommand. The shim is written to
   `$SWE_HOME/bin/gh`, which is prepended to the child's PATH, and it
   `import`s the classifier from the compiled module rather than restating the
   rules — one implementation, which the tests exercise by running the shim.
   It also deletes both token variables from what the real `gh` inherits.

4. **Unmatched invocations get the READ credential.** The rule table will miss
   a subcommand eventually; when it does, the call must fail with a
   permissions error rather than silently execute with the App's wider
   credential. Adding a rule is a one-line fix; a silent privilege escalation
   is not.

5. **`resolveDelegatedWriteToken` accepts `knownLogin`**, skipping the `/user`
   lookup when the orchestrator already resolved the caller
   (`AGENT_ACTOR_LOGIN`). This removes the last instance of the call that
   motivated excluding the `github` provider.

## Consequences

A run can only read what the person who asked can read. Writes still land as
the App, so PRs and commits carry the agent's identity — which was always the
intent — and the human is recorded via the `Co-authored-by` trailer.

**Enabling this is a deployment change, not a code change.** The Agent must
declare `github` in `identityLink.providers`. Until it does, `isDelegating()`
stays false and every run takes the single-installation-token path exactly as
before. Nothing here alters non-delegating behaviour.

**The boundary is structural, not adversarial.** The agent runs arbitrary
bash, so it can reach the real `gh` by absolute path, and the push token is
present in `.gitconfig`. This makes the correct credential the default for
every ordinary operation, and makes over-privileged reads require deliberate
circumvention rather than being what happens by default. Confining a write
credential the agent must be able to use is a containment problem, not a
credential-selection one, and is out of scope here.

**Two humans, one GitHub account.** A caller whose chat identity and GitHub
identity are different people still reads as the linked GitHub account. That
is inherent to 0029's canonical-subject choice, not new here.

`githubId` becomes optional on the attribution and co-author types: it comes
only from the `/user` lookup that §5 skips. The trailer falls back to the
`login@users.noreply.github.com` form, which GitHub still attributes.
