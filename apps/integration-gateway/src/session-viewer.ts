import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionView } from "./orchestrator-client.js";

/**
 * The interactive "watch the agent work / send it another prompt" page
 * (see the task this implements: an issue-triage agent should surface a
 * live-ish view of its own session, not just a final GitHub comment).
 *
 * This gateway is the only internet-reachable piece of the system (see
 * docs/integrations-gateway.md), so it hosts the page itself, proxying the
 * underlying session data from agent-orchestrator's own (cluster-internal)
 * `GET /sessions/:sessionId` via `OrchestratorClient.getSession`.
 *
 * A GitHub issue -- and therefore any link posted onto it -- is often
 * public, so the link itself must be an unguessable capability: `token` is
 * an HMAC of the session id under a gateway-only secret
 * (`GATEWAY_SESSION_VIEWER_SECRET`), not a stored/random value, so it can be
 * computed the moment a session id is known (before agent-orchestrator has
 * even created a `SessionRecord` for it) and verified statelessly on every
 * request without a shared secret with any other service.
 */

const TOKEN_BYTE_LENGTH = 16;

/** Derives this session's capability token -- see this module's doc comment. */
export function signSessionToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("hex").slice(0, TOKEN_BYTE_LENGTH * 2);
}

/** Constant-time check of a caller-supplied token against the expected one for `sessionId`. */
export function verifySessionToken(secret: string, sessionId: string, token: string | null): boolean {
  if (!token) return false;
  const expected = signSessionToken(secret, sessionId);
  const expectedBuf = Buffer.from(expected, "hex");
  const tokenBuf = Buffer.from(token, "hex");
  if (expectedBuf.length !== tokenBuf.length) return false;
  return timingSafeEqual(expectedBuf, tokenBuf);
}

/**
 * Builds the public URL for a session's viewer page, e.g. to embed in the
 * "starting work" GitHub comment. `baseUrl` is this gateway's own public
 * base URL (`GATEWAY_SESSION_VIEWER_BASE_URL`) -- deliberately a separate
 * config value from any ingress host lookup, since the gateway process
 * itself has no reliable way to know its own externally-visible URL.
 */
export function sessionViewerUrl(baseUrl: string, secret: string, sessionId: string): string {
  const token = signSessionToken(secret, sessionId);
  return `${baseUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}?token=${token}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders the session-viewer HTML page: the transcript so far (if any), a
 * "still working" banner when `view.pending`, and a form to send another
 * prompt (POSTs back to this same gateway, see server.ts's
 * `handleSessionMessage`). Deliberately dependency-free inline HTML/CSS, no
 * build step -- same convention as `identity-link/api.ts`'s `htmlPage`.
 */
export function renderSessionPage(sessionId: string, token: string, view: SessionView | undefined): string {
  const transcript = view?.transcript ?? [];
  const pending = view?.pending ?? false;
  const messages = transcript.length
    ? transcript
        .map(
          (entry) => `<div class="msg ${entry.role}">
  <div class="role">${entry.role === "user" ? "Requester" : "Agent"}</div>
  <div class="text">${escapeHtml(entry.text)}</div>
</div>`,
        )
        .join("\n")
    : `<p class="empty">No messages yet.</p>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent session ${escapeHtml(sessionId)}</title>
${pending ? `<meta http-equiv="refresh" content="10">` : ""}
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.1rem; word-break: break-all; }
  .banner { background: #fff3cd; border: 1px solid #ffe69c; border-radius: 6px; padding: 0.5rem 0.75rem; margin-bottom: 1rem; }
  .msg { border-radius: 8px; padding: 0.5rem 0.75rem; margin-bottom: 0.5rem; }
  .msg.user { background: #eef2ff; }
  .msg.agent { background: #f3f4f6; }
  .role { font-size: 0.75rem; font-weight: 600; opacity: 0.6; text-transform: uppercase; }
  .text { white-space: pre-wrap; }
  .empty { opacity: 0.6; }
  form { margin-top: 1.5rem; }
  textarea { width: 100%; box-sizing: border-box; min-height: 5rem; font-family: inherit; padding: 0.5rem; }
  button { margin-top: 0.5rem; padding: 0.5rem 1rem; }
</style>
</head>
<body>
<h1>Session: ${escapeHtml(sessionId)}</h1>
${pending ? `<div class="banner">The agent is still working on this. This page refreshes automatically.</div>` : ""}
${messages}
<form method="post" action="/sessions/${encodeURIComponent(sessionId)}/messages?token=${escapeHtml(token)}">
  <label for="text">Send the agent another instruction:</label><br>
  <textarea id="text" name="text" placeholder="e.g. also update the README" required></textarea><br>
  <button type="submit">Send</button>
</form>
</body>
</html>`;
}
