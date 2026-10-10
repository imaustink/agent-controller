# 0046. A Connections page for managing linked accounts, signed in through the deployment's own IdP

Status: proposed

## Context

Every per-user credential an agent uses (GitHub per ADR 0022; Claude per ADR
0027; Atlassian, Google and Slack per ADR 0040) reaches the user the same way:
as a markdown link dropped into a chat answer at the moment something needs it.
A knowledge-base question that spans three sources produces three bullet points
of raw OAuth URLs and "ask again once you've linked". Each provider's flow ends
on its own dead-end page ("You can close this tab"), and the authcode one said
"GitHub account linked" for every provider.

That is workable as a fallback but poor as the only surface. A user cannot:

- see what they have linked, or as whom;
- link something ahead of time, before a question needs it;
- relink an expired account before it breaks a turn;
- remove a link at all. No route lists or deletes a user's credentials.

What makes a central page non-trivial is identity. Every credential is keyed by
the chat subject `openwebui:<id>` (Claude's by the `github:<login>` principal
derived from it, ADR 0029/0031). That id is Open WebUI's internal user id, and
it reaches us only inside the HS256 JWT Open WebUI signs per model request
(`X-OpenWebUI-User-Jwt`). A browser never holds that token, and nothing here has
a browser login or a cookie.

## Decision

### 1. A server-rendered page on integration-gateway

`GET /connections` lists one card per provider the gateway can link, with its
status (connected as *account*, needs reconnecting, not connected), and
Connect / Reconnect / Disconnect buttons. It lives on the gateway because the
gateway already owns every credential store, every link flow, and the public
hostname their callbacks use. Like the gateway's other pages it is plain HTML
with form posts: no framework and no script, under `default-src 'none'`.

- **Connect** starts the provider's own flow for the signed-in user's subject:
  - the authcode linker for GitHub, Atlassian, Google and Slack;
  - the PTY page for `claude` and `claude-remote`.

  The flow lands in the same store under the same key a chat turn would use.
  A turn already waiting on that link (`/wait`) therefore resumes unchanged.
- **Return to the page.** A short-lived signed `cx_return` cookie tells the
  provider's callback, and the Claude paste-the-code page, to redirect back to
  `/connections?connected=<provider>` instead of the dead-end page. Links
  started from anywhere else keep the old result page. The cookie is consumed
  on use and checked against the provider being completed.
- **Disconnect** deletes our stored credential (`IdentityLinkStore.delete` is
  new; `ClaudeTokenStore.delete` already existed). It does not revoke the grant
  at the provider. The card links to the provider's own settings page for that.
- **Claude is keyed on the GitHub principal**, exactly as agent-orchestrator
  keys it. Its card is therefore disabled until GitHub is connected, and the
  page reads both the principal and the raw subject (for pre-principal
  records).
- **GitHub requires the authcode flow** to be configured. The device flow
  needs a poller, and the page has no script.

### 2. Sign-in is generic OIDC against the deployment's IdP

The page runs an authorization-code + PKCE + nonce login against whatever
issuer it is configured with:

- Pocket ID in the homelab;
- Keycloak (`https://<host>/realms/<realm>`) elsewhere.

All endpoints come from discovery, so changing IdP is three values: issuer,
client id, client secret.

The ID token comes back on the back channel from the token endpoint over TLS,
in exchange for our client secret. Its signature is therefore not re-verified
against JWKS, as OIDC Core §3.1.3.7(6) permits. Its `iss`, `aud`, `exp` and
`nonce` are verified.

The session is an HMAC-signed, `HttpOnly`, `SameSite=Lax` cookie scoped to
`/connections`. Its key is derived from the existing identity-link state
secret, so the page adds no Secret key beyond the OIDC client secret.
State-changing posts also carry a per-session CSRF token.

### 3. The verified email maps a sign-in to the chat subject

Open WebUI's forwarded JWT carries `sub` (its user id) and `email` under one
signature. agent-orchestrator already verifies that JWT on every chat request;
it now also records `email → openwebui:<id>` with the gateway:

- the route is `PUT /connections/api/principals`, bearer-gated with the
  identity-link token;
- the record is sent once per user per process;
- it is fire-and-forget, so it never delays or fails a turn;
- only `perUser` identities are recorded.

The page looks the signed-in email up in that directory, which is stored as
Kubernetes Secrets like every other credential record (ADR 0034).

**This is a lookup table, not a re-key.** No credential moves onto an email.
Re-keying is what produced the PR #144 triage re-authorization loop. A mapping
cannot strand a credential: deleting it only makes the page say "send a chat
message first".

A user who has never chatted has no mapping yet. The page tells them to send
one message and reload, rather than guessing.

### 4. Chat prompts point at the page

With `AGENT_CONNECTIONS_URL` set (`https://<gw>/connections`), a chat caller's
link prompt is the page's one-click deep link (§5) rather than a raw provider
URL, and a turn gets ONE such link however many providers it is missing:

- an agent run missing Claude and Claude Remote Control gets
  `[connect your Claude and Claude Remote Control accounts](https://<gw>/connections/link?need=claude,claude-remote)`;
- a knowledge-base answer missing several sources gets
  `[Connect Atlassian and Google Drive](…/connections/link?need=atlassian,google)`
  instead of a bullet per provider.

Nothing is started at the provider when the page is used. This also stops a
`claude setup-token` PTY being spawned for a link the user may complete
somewhere else. The turn still parks and waits exactly as before, because the
page writes to the same `(provider, subject)` record.

For an agent run, `AuthorizationService.authorize` assesses every provider
first and holds the missing ones back, then offers the single link and waits
on each provider in the order the page links them. Once one wait ends without
a credential the user has stopped, so the rest park without waiting again.
Everything ADR 0030/0031 pins still holds:

- **Principal first.** A pending GitHub principal is offered at once, and
  nothing after it is assessed until it lands. Its link names the providers
  after it too, as names only: they are not read or keyed, and the page keys
  each one itself exactly as the orchestrator does (Claude on the GitHub
  principal) and skips any already connected. If the principal lands during
  the wait, the turn carries on under it and does not offer the rest a second
  time: the user is already being walked through them.
- **Exact keying.** Each provider waits on, and is parked against, the
  `credentialSubject` it was read under. Nothing re-derives it.
- **Resume.** The resume anchor is still the first pending provider.
  Re-entering the gate re-assesses everything, so the next turn's link names
  only what is still missing.

Direct links remain wherever the page cannot help:

- a caller that is not an Open WebUI user, such as the GitHub triage relay,
  whose subject is shared and has no browser session behind it;
- a caller that explicitly asked for the device flow;
- any deployment with the page off.

**Both engines.** The Temporal engine (`engines/temporal`) does the same:
`authz.Authorize` and the knowledge-base activity emit the one deep link under
the same three conditions (URL configured, `openwebui:` subject, not device
flow). It reads the same `AGENT_CONNECTIONS_URL`, set by the temporal-engine
chart's `identityLink.connectionsUrl`. On Temporal a page link is never
re-checked against a resume anchor the way a device code is: nothing was
started, so there is no flow to race.

### 5. The one-click deep link: `GET /connections/link?need=a,b`

A link in chat should cost one click, not a visit to a page and a click per
provider. The deep link:

1. **Signs in invisibly.** Without a page session it runs the ordinary OIDC
   login with `next` pointing back at itself. With a live IdP session and no
   consent screen due, the IdP answers at once, so the user never sees it.
   Pocket ID remembers consent per user and client, and a client can skip it
   outright (`skipConsent`, which the homelab provisioning script sets).
2. **Plans.** Keeps the providers this gateway can link and orders them:
   GitHub first, since Claude is filed under the principal it establishes;
   the redirect-based providers next; `claude` and then `claude-remote` last,
   because theirs are paste-the-code pages rather than a consent screen that
   bounces straight back.
3. **Walks.** Each step re-reads every needed provider's status, skips what is
   connected, and redirects straight to the next provider's own consent or
   page. Our page is never shown in between. When nothing is missing it shows
   "You're all set, go back to your chat".

The chain rides in the signed `cx_return` cookie: the providers chat asked for
and the ones this chain has already sent the user through. A provider's
callback consumes it and, mid-chain, re-issues it under a different signing
purpose for `/connections/link/next`, so neither token can stand in for the
other.

**When the chain stops, it stops on the page** (`/connections?need=<missing>`),
which still highlights what chat needs. Whatever the chain already connected
stays connected. It stops when:

- the user declines at a provider. The identity-link callback's `error`
  branch asks the page first (`cancelRedirect`) and only shows its static
  "cancelled" page for a link the page did not start;
- a provider is blocked (Claude without GitHub);
- a provider's flow will not start;
- **a provider the chain already tried is still missing.** Its callback
  reported success but nothing persisted. Offering it again would loop
  forever, so a chain tries each provider at most once.

**Why a GET may start a link.** Every other state change here is a form post
with a CSRF token. This one is a GET so it works as a plain link from chat,
and that is acceptable because of what it can do:

- it acts only on the signed-in user's OWN subject, resolved from their own
  session, never from the URL;
- it only starts links for providers that are missing, and the provider
  still asks that user for consent;
- the consent and the code come from the user's own browser session at the
  provider, and the gateway's `state` binds the result to their subject. A
  forged navigation can therefore at worst show someone a consent screen for
  their own account, or quietly refresh a link to the account they are already
  signed in to. It cannot attach an attacker's account or remove anything.

Connect, Disconnect and Sign out keep their CSRF tokens.

The Claude Remote Control card and chain step still run the full
`claude auth login` flow (`ClaudeLoginFlows`, `mode=login`). The chain only
decides when to send the user there.

## Security and IdP requirements

The email is the join, so the page is exactly as trustworthy as the emails on
both sides of it:

- **Verified emails only.** The page refuses an ID token whose `email_verified`
  is not true. `GATEWAY_CONNECTIONS_ALLOW_UNVERIFIED_EMAIL` exists for an IdP
  that does not emit the claim. Startup warns loudly when it is set.
- **One IdP on both sides.** Open WebUI must sign people in through the same
  IdP the page does. An Open WebUI account created some other way (a local
  password signup) carries an email nobody verified. If someone registers
  `victim@corp` that way, a later sign-in by the real victim would manage the
  impostor's subject; worse, it would *connect the victim's accounts into it*.
  Disable Open WebUI's password signup and login form wherever the page is on,
  or ensure new accounts need admin approval (pending users never reach the
  model, so they are never recorded).
- **Keycloak realm checklist:**
  - "Duplicate emails" off (the default);
  - "Verify email" on, or "Edit username/email" disabled for users, so an
    address cannot be changed to someone else's without proof;
  - the client is confidential (client authentication on), with standard flow
    only;
  - the valid redirect URI is exactly `<publicBaseUrl>/connections/callback`.
- **Pocket ID:** the client is confidential, with callback
  `<publicBaseUrl>/connections/callback`. Users need a verified email, and
  Pocket ID marks emails UNVERIFIED by default: `EMAILS_VERIFIED` defaults to
  false, admin-created and self-signed-up users start unverified, and only
  LDAP-synced users are verified automatically. Tick "Email verified" per user,
  set `EMAILS_VERIFIED=true`, or enable `EMAIL_VERIFICATION_ENABLED`. Pocket ID
  sends `email_verified` only with the `email` scope, which the page requests.

Latest write wins in the directory. Open WebUI allows one account per email, so
two live subjects cannot both claim an address. A newer subject means the
account was deleted and recreated, and following it is the right answer.

## Consequences

- A user can see, add, refresh and remove every linked account from one
  bookmarkable page. Chat prompts converge on it, so linking looks the same
  every time.
- The gateway gains its first browser session. It is narrowly scoped: one
  cookie on `/connections`, signed rather than stored, eight hours by default.
- `IdentityLinkStore` gains `delete`. Its Kubernetes implementation propagates
  failures rather than swallowing them, unlike `set`, so a Disconnect cannot
  report success while the credential survives.
- Production stays off until a Pocket ID client exists. `values-production.yaml`
  carries the steps, and the homelab repo's
  `kubernetes/manifests/services/pocket-id/provision-agent-connections.sh`
  creates the client.
- The client secret can live in a Secret of its own
  (`connections.oidc.clientSecretExistingSecret` / `…Key`) for a deployment
  whose IdP operator writes one when it provisions the client, instead of being
  copied into the gateway's main Secret.

## Not done

- **Provider-side revocation.** Disconnect forgets our copy; the grant remains
  at GitHub, Google and the others until the user removes it there. The card
  says so and links to the right settings page.
- **The device flow from the page.** It would need a poller.
- **Triage-only users** (GitHub webhook callers with no Open WebUI account)
  have no subject the page can map, and keep their direct links.
