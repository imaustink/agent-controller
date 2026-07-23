import type { SessionPageEntry, SessionTurn } from "./session-page-store.js";

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function turnHtml(turn: SessionTurn, index: number): string {
  const statusLabel = turn.status === "pending" ? "working…" : turn.status;
  const body = turn.status === "pending" ? "" : escapeHtml(turn.result ?? turn.error ?? "");
  return `<article class="turn">
  <p class="request"><strong>#${index + 1}</strong> ${escapeHtml(turn.request)}</p>
  <p class="status status-${turn.status}">${statusLabel}</p>
  ${body ? `<pre class="response">${body}</pre>` : ""}
</article>`;
}

/**
 * Renders the session page (issue #81): read-only turn history plus a form
 * to send another prompt into the same orchestrator session. Server-rendered,
 * no client JS -- while a turn is pending the page just meta-refreshes every
 * 5s, same "no new infra" spirit as the rest of this gateway.
 */
export function renderSessionPage(entry: SessionPageEntry): string {
  const pending = entry.turns.some((t) => t.status === "pending");
  const issueUrl = `https://github.com/${entry.owner}/${entry.repo}/issues/${entry.issueNumber}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${pending ? '<meta http-equiv="refresh" content="5">' : ""}
<title>${escapeHtml(entry.owner)}/${escapeHtml(entry.repo)} #${entry.issueNumber} -- agent session</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  .turn { border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
  .status { text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.04em; color: #666; }
  .status-failed { color: #b00020; }
  .response { white-space: pre-wrap; word-break: break-word; background: #f6f6f6; padding: 0.75rem; border-radius: 6px; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 0.5rem; }
  button { margin-top: 0.5rem; padding: 0.5rem 1.25rem; }
</style>
</head>
<body>
<h1>${escapeHtml(entry.owner)}/${escapeHtml(entry.repo)} #${entry.issueNumber}</h1>
<p><a href="${issueUrl}">View issue on GitHub</a></p>
${entry.turns.map(turnHtml).join("\n") || "<p>No turns yet.</p>"}
<form method="post" action="/sessions/${entry.token}/prompts">
  <label for="prompt">Send another prompt into this session</label>
  <textarea id="prompt" name="prompt" rows="4" required></textarea>
  <button type="submit">Send</button>
</form>
</body>
</html>`;
}
