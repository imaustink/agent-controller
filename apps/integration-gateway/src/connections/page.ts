import type { ConnectionProvider, ConnectionStatus } from "./providers.js";

/**
 * Server-rendered HTML for the Connections page (docs/adr/0046). No framework
 * and no client-side script, same as every other page this gateway serves --
 * a list of cards with plain form posts is all it needs, and it keeps the
 * page's CSP at `default-src 'none'`.
 */

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root {
  --bg: #f6f7f9; --card: #ffffff; --text: #16181d; --muted: #5d6470; --border: #e2e5ea;
  --accent: #2f5bea; --accent-text: #ffffff; --ok: #1f8a4c; --warn: #b26a00; --danger: #c0362c;
  --highlight: #fff7e0; --chip: #eef0f4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111317; --card: #1a1d23; --text: #e8eaee; --muted: #9aa1ad; --border: #2b2f38;
    --accent: #6d8cff; --accent-text: #0b0d12; --ok: #4cc27f; --warn: #e3a33b; --danger: #ff6b5f;
    --highlight: #2a2412; --chip: #252a33;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { font-size: 1.5rem; margin: 0; }
.who { color: var(--muted); font-size: 0.875rem; display: flex; gap: 0.75rem; align-items: center; }
.lede { color: var(--muted); margin: 0.5rem 0 1.5rem; }
.flash { border: 1px solid var(--border); background: var(--card); border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
.flash.ok { border-color: var(--ok); }
.flash.error { border-color: var(--danger); }
.need { background: var(--highlight); border-radius: 10px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
ul.cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.25rem;
  display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 1rem; align-items: center; }
.card.needed { border-color: var(--warn); box-shadow: 0 0 0 1px var(--warn); }
.card h2 { font-size: 1rem; margin: 0; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.card p { margin: 0; color: var(--muted); font-size: 0.875rem; grid-column: 1; }
.status { font-size: 0.75rem; font-weight: 600; border-radius: 999px; padding: 0.1rem 0.55rem; background: var(--chip); }
.status.connected { color: var(--ok); }
.status.needs-reconnect { color: var(--warn); }
.status.not-connected, .status.blocked { color: var(--muted); }
.actions { grid-column: 2; grid-row: 1 / span 3; display: flex; gap: 0.5rem; }
form { margin: 0; }
button { font: inherit; font-size: 0.875rem; border-radius: 8px; padding: 0.45rem 0.9rem; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--text); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.link { border: none; padding: 0; color: var(--muted); text-decoration: underline; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.note { font-size: 0.8rem; color: var(--muted); }
.note a { color: inherit; }
footer { margin-top: 2rem; font-size: 0.8rem; color: var(--muted); }
@media (max-width: 34rem) {
  .card { grid-template-columns: 1fr; }
  .actions { grid-column: 1; grid-row: auto; margin-top: 0.5rem; }
}`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface ConnectionRow {
  provider: Pick<ConnectionProvider, "id" | "label" | "description" | "revokeUrl">;
  status: ConnectionStatus;
}

export interface ConnectionsPageModel {
  email: string;
  rows: ConnectionRow[];
  /** Providers a chat turn is waiting on, highlighted at the top. */
  needed: string[];
  flash?: { kind: "ok" | "error"; message: string };
  /** Opaque per-session token every form posts back, checked against the session. */
  csrf: string;
}

const STATUS_TEXT: Record<ConnectionStatus["state"], string> = {
  connected: "Connected",
  "needs-reconnect": "Needs reconnecting",
  "not-connected": "Not connected",
  blocked: "Not available yet",
};

function renderRow(row: ConnectionRow, needed: boolean, model: ConnectionsPageModel): string {
  const { provider, status } = row;
  const id = escapeHtml(provider.id);
  // `need` rides along so the page still highlights what chat is waiting on
  // when the provider sends the user back.
  const csrfField =
    `<input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}">` +
    (model.needed.length ? `<input type="hidden" name="need" value="${escapeHtml(model.needed.join(","))}">` : "");
  const account = status.account ? ` as <strong>${escapeHtml(status.account)}</strong>` : "";

  let actions: string;
  if (status.state === "connected") {
    actions = `<form method="post" action="/connections/${id}/connect">${csrfField}<button type="submit">Reconnect</button></form>
<form method="post" action="/connections/${id}/disconnect">${csrfField}<button type="submit">Disconnect</button></form>`;
  } else if (status.state === "blocked") {
    actions = `<button type="button" disabled>Connect</button>`;
  } else {
    const label = status.state === "needs-reconnect" ? "Reconnect" : "Connect";
    actions = `<form method="post" action="/connections/${id}/connect">${csrfField}<button class="primary" type="submit">${label}</button></form>`;
    if (status.state === "needs-reconnect") {
      actions += `<form method="post" action="/connections/${id}/disconnect">${csrfField}<button type="submit">Remove</button></form>`;
    }
  }

  const detail =
    status.state === "blocked" && status.detail
      ? `<p>${escapeHtml(status.detail)}</p>`
      : status.state === "connected" && provider.revokeUrl
        ? `<p class="note">Disconnect removes our copy. To revoke access completely, also remove it in your <a href="${escapeHtml(provider.revokeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(provider.label)} settings</a>.</p>`
        : "";

  return `<li class="card${needed ? " needed" : ""}" id="${id}">
<h2>${escapeHtml(provider.label)} <span class="status ${status.state}">${STATUS_TEXT[status.state]}${status.state === "connected" ? account : ""}</span></h2>
<p>${escapeHtml(provider.description)}</p>
${detail}
<div class="actions">${actions}</div>
</li>`;
}

export function renderConnectionsPage(model: ConnectionsPageModel): string {
  const neededSet = new Set(model.needed);
  const outstanding = model.rows.filter((r) => neededSet.has(r.provider.id) && r.status.state !== "connected");
  const flash = model.flash
    ? `<div class="flash ${model.flash.kind}" role="status">${escapeHtml(model.flash.message)}</div>`
    : "";
  const need =
    outstanding.length > 0
      ? `<div class="need">Your chat is waiting on <strong>${outstanding
          .map((r) => escapeHtml(r.provider.label))
          .join("</strong> and <strong>")}</strong>. Connect below, then go back to your chat; it picks up once you're done.</div>`
      : model.needed.length > 0
        ? `<div class="flash ok">Everything your chat needed is connected. You can go back to it now.</div>`
        : "";
  const rows = model.rows.length
    ? `<ul class="cards">${model.rows.map((r) => renderRow(r, neededSet.has(r.provider.id), model)).join("\n")}</ul>`
    : `<p>No services are set up for linking on this deployment.</p>`;

  return shell(
    "Connections",
    `<header>
<h1>Connections</h1>
<div class="who"><span>${escapeHtml(model.email)}</span>
<form method="post" action="/connections/logout"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}"><button class="link" type="submit">Sign out</button></form></div>
</header>
<p class="lede">Accounts your agents can use on your behalf. Each one acts only as you, with your own access.</p>
${flash}
${need}
${rows}
<footer>Agents will still ask for a connection in chat if they need one you haven't set up here.</footer>`,
  );
}

/** A standalone message page, for outcomes with no session to show the list under. */
export function renderMessagePage(title: string, message: string, action?: { href: string; label: string }): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(message)}</p>
${action ? `<p><a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : ""}`,
  );
}
