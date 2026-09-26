# 0044. The ingestion credential is a long-lived API token, not OAuth

Date: 2026-09-26

## Status

Accepted. Narrows ADR 0038 §2 (Connection credentials) for Atlassian
specifically; ADR 0040 is untouched — the per-user delegated path stays OAuth.

## Context

A Corpus syncs on a schedule with no user present. It runs on the Connection's
`SERVICE_TOKEN`, read from a Kubernetes Secret by `resolveServiceToken`.

Nothing in the broker refreshes that value. For Slack that is fine: a bot token
does not expire. For Atlassian it is not. An OAuth access token lives about an
hour, and its refresh token ROTATES — each refresh invalidates the last.

So the shipped arrangement had a defect that testing could not surface, because
every harness run mints a fresh token by hand:

> Confluence ingestion works for one hour after someone pastes a token into a
> Secret, then fails permanently, and the failure looks like a permissions
> problem rather than an expiry.

Three ways out.

**1. OAuth with refresh in the broker.** Correct in the abstract, and the most
work by a distance. The broker would need durable storage for a rotating
refresh token and single-writer discipline around it: two sync pods refreshing
concurrently means one wins, the other holds a token that is already dead, and
the connection is locked out until a human re-links. This project has been bitten
by exactly that failure mode before — a rotating refresh token plus a single
write-back with no retry is what produced the recurring claude-remote re-auth
loop. It also ties a client's ingestion to one employee's OAuth grant, which
ends the first time that person leaves.

**2. A Forge or Connect app.** The right answer for a product. App-level auth,
no user behind it, no rotation. It also means publishing and installing an
Atlassian app, per tenant, with a review process — a large amount of ceremony
for a deployment that reads one company's own wiki.

**3. An API token on a dedicated service account.** Atlassian Cloud accepts
`email:token` as HTTP Basic against the REST API. Long-lived, no rotation, no
refresh machinery, revocable from the admin console, and issued against exactly
one site.

## Decision

**Option 3.** The ingestion credential for Confluence is an API token belonging
to a dedicated service account, supplied as `email:token`.

The driver accepts both shapes and picks by inspecting the credential:

- `email:token` → HTTP Basic, addressed **directly at the site**.
- anything else → `Bearer`, addressed at the **OAuth gateway**
  (`api.atlassian.com/ex/confluence/{cloudId}`).

The routing difference is not cosmetic. `/oauth/token/accessible-resources` is
an OAuth endpoint and does not answer for Basic auth, so an API token sent
through the gateway fails during cloudId resolution — before the first real
call, with an error about tenant discovery rather than about credentials.

The discriminator is the `@` in the first half, not the colon alone: an opaque
OAuth token may contain punctuation, and guessing wrong sends a valid
credential to the wrong host with the wrong scheme.

`email:token` is not a format of ours — it is what Atlassian's own
documentation tells you to base64. An operator pastes the two halves they
already have.

### What this does NOT change

Per-user reads stay OAuth. `readAsUser` and `searchAsUser` run on the caller's
delegated token, minted by the integration-gateway's authcode linker and
refreshed there, where rotation is already handled and there is a user present
to re-link if it breaks.

That asymmetry is the point. The two credentials answer different questions —
"what does this corpus contain", asked by a cron job, and "what may this person
see", asked on their behalf — and they have opposite requirements. Ingestion
needs to survive unattended for months. A delegated read needs to expire.

### Service account requirements

- A real Atlassian account, licensed, not a personal one.
- Granted read on exactly the spaces its Corpora scope to. The scope check in
  the driver is a second boundary, not the only one.
- `search:confluence` is irrelevant here: scopes are an OAuth concept, and an
  API token carries the account's own permissions. Live lookup runs on the
  DELEGATED token, which does need that scope (see providers.ts).

## Consequences

**Ingestion survives unattended**, which is the whole point.

**The credential is as privileged as the account.** An API token is not
scope-limited the way an OAuth grant is — it can do anything its account can.
That is why the account is dedicated and read-only rather than a human's. The
blast radius of a leaked ingestion credential is "read the spaces this account
was granted", which is the same blast radius the corpus already has.

**Atlassian is moving API tokens toward scoped tokens.** Unscoped tokens still
work and are still issued. When that changes, a scoped token is the same Basic
shape with a narrower grant, so this decision survives it; what would not
survive is having built option 1.

**Drive has the same defect and is NOT fixed here.** A Google access token
expires in an hour too, and `core_v1alpha1_connection_gdrive.yaml` names its
secret key `accessToken`. Drive's answer is a service account with a JSON key
and domain-wide delegation, which is a different mechanism — worth its own
change rather than a guess bolted onto this one. Recorded so it is not
discovered the same way this was.
