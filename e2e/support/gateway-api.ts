import { withPortForward } from "./k8s.js";

/**
 * integration-gateway's internal, bearer-gated identity-link API.
 *
 * Driven directly, rather than through a turn, for the one behaviour no turn can
 * reach: GitHub token REFRESH. The orchestrator asks for a github *token* only
 * when an Agent declares the `github` provider, and the e2e catalog's agents
 * declare `claude`/`claude-remote` (deliberately -- docs/adr/0030 §5 removed it,
 * and docs/adr/0031's principal step asks for a login, not a token). Reaching the
 * refresh path through a turn would mean adding an agent that exists only to be
 * reached, so the gateway is called where it lives instead.
 */

const GATEWAY_SERVICE = "agent-controller-integration-gateway";
const GATEWAY_PORT = 8090;
const LOCAL_PORT = 18096;

/** Matches `GATEWAY_IDENTITY_LINK_TOKEN` in e2e/scripts/bootstrap-secrets.sh, which fixes it deliberately. */
const BEARER = "e2e-identity-link-token";

/**
 * The HTTP status of `GET /identity-link/github/token` for a subject -- and
 * ONLY the status.
 *
 * Returning the status alone is deliberate: `200` vs `404` is the entire
 * question a spec asks here ("is this link usable, or does the gateway consider
 * it dead?"), and a helper that returned the body would put a live credential in
 * reach of a failure message. The suite's rule is that it reads key names and
 * metadata, never credential values (see support/redis.ts).
 */
export async function identityLinkTokenStatus(subject: string): Promise<number> {
  return withPortForward(GATEWAY_SERVICE, GATEWAY_PORT, LOCAL_PORT, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/identity-link/github/token?subject=${encodeURIComponent(subject)}`, {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    return res.status;
  });
}

/**
 * The GitHub login the gateway reports for a subject, or `undefined` on 404.
 *
 * The identity question (docs/adr/0031), which is answerable for a link whose
 * token has expired -- unlike {@link identityLinkTokenStatus}. A login is not a
 * credential, which is why this one may return its value.
 */
export async function identityLinkLogin(subject: string): Promise<string | undefined> {
  return withPortForward(GATEWAY_SERVICE, GATEWAY_PORT, LOCAL_PORT, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/identity-link/github/identity?subject=${encodeURIComponent(subject)}`, {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`e2e: identity lookup failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { githubLogin?: string }).githubLogin;
  });
}
