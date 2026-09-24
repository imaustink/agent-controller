# 0042. An agent that acts on GitHub launches only into a repository its caller can read

Status: accepted

## Context

[ADR 0041](0041-delegated-read-write-token-split.md) settled what a run's two
GitHub credentials are for: reads run as the person who asked, writes run as
the App. It left two things open.

1. **Nothing checked before launch.** The only access check was inside the
   agent's own pod, after it had started, and only for a continuation that
   already named its repository. It checked WRITE permission, when the model
   is that reads are the user's and writes are the App's. A fresh chat request
   was never checked, so a pod started for anyone with the `writer` role.
2. **It was never switched on.** Delegation only activates when the Agent
   declares the `github` identity provider, and no deployed
   `claude-code-swe-agent` did. Every run read with the App's installation
   token, which can see every repository the App is installed on.

The bitovi incident behind [PR #244](https://github.com/imaustink/agent-controller/pull/244)
showed why that matters. A chat user who never linked GitHub still had the
agent open a pull request. It ran on the App's token, and, after an identity
downgrade, on a Claude credential that was not theirs.

## Decision

**An agent that declares `github` launches only after its caller is shown to
be able to read the repository it will work in.** The check is part of the
authorization pre-flight (`authz.gateRepository` in the Temporal engine),
so it is plain control flow like the rest of the pre-flight
([ADR 0030](0030-authorization-preflight-outside-the-llm.md)), and a refusal
launches nothing.

1. **Declaring `github` is the switch.** It already meant "this run reads as its
   caller"; it now also means "this run is gated on its caller's read access".
   `claude-code-swe-agent` declares it.

2. **Chat: checked with the caller's own token.** The repository comes out of
   the request: a GitHub URL is taken as-is, and otherwise a model extracts
   `owner`/`name`. Every part it returns must appear literally in the
   request. A bare name takes the deployment's default owner
   (`temporal-engine.github.defaultOwner`), and with none, the user is asked.
   The engine then calls `GET /repos/{owner}/{name}` with the caller's GitHub
   token:
   - **200:** launch.
   - **404 or 403:** refuse. GitHub answers 404 for a private repository the
     token cannot see.
   - **401:** a dead link, reported as such rather than as a denial.
   - **Anything else:** an error, so the activity retries and never launches
     unchecked.

   No repository named means asking which one, not launching.

3. **Webhook: checked by the adapter, and no user token at all.** The
   repository is the event's own, never one read from the prompt.
   integration-gateway already checks the sender's collaborator permission on
   that repository before relaying, and vouches for the sender with a signed
   assertion. The pre-flight never looks up, starts, or injects a `github`
   token for a shared subject: `github` is keyed by the raw subject, so the
   first person to link under the webhook's service identity would become
   every sender's read identity. A shared subject with **no** verified sender
   is refused, which is exactly the shape of a chat turn that lost its
   identity on the way in.

4. **The run is told what was checked.** `AGENT_TARGET_REPOSITORY` carries the
   repository into the run. Every App token the agent mints is scoped to it
   (`repositories: [name]`), so the repository that was checked is the only
   one the run can write to. With a verified target there is no post-flight
   (`finalizeDelegatedWrite`): nothing else was writable.

## Consequences

- **A caller must link GitHub** to use a GitHub-acting agent from chat. That
  was already true for principal establishment
  ([ADR 0031](0031-principal-establishing-account-link.md)); the link is now
  also what the read check runs on.
- **Creating a new repository from chat is no longer possible** through these
  agents, since there is nothing to read yet. A request that names a
  repository that does not exist is refused like one the caller cannot see.
- **The model picks which repository is checked, never whether the check
  passes.** A wrong extraction can only point the run at another repository
  the same caller can already read.
- **The webhook's repository is not signed.** The sender login travels in a
  signed assertion, but `owner`/`repo` arrive in the unsigned event body of an
  `/invoke` call authenticated with the adapter's service token. Anything
  holding that token could already act as the adapter. Signing the repository
  into the assertion is the follow-up if that token's audience widens.
- **The LangGraph engine does not have this gate.** A deployment on
  `AGENT_ENGINE=langgraph` that declares `github` gets ADR 0041's
  delegation, so reads still run as the caller, but there is no pre-launch
  check and no scoped write token. See
  `engines/temporal/docs/langgraph-parity-audit.md`.
- **Deployments opt in with values, not code:**
  - add `github` to `claudeCodeSweAgent.identityLink.providers`;
  - set `temporal-engine.github.apiUrl` if the tokens are not from
    api.github.com;
  - optionally set `defaultOwner`.
