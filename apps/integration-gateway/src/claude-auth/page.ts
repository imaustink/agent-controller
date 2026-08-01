function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  a.button { display: inline-block; background: #0a66c2; color: #fff; text-decoration: none; padding: 0.6rem 1.25rem; border-radius: 6px; margin: 1rem 0; }
  input[type="text"] { width: 100%; box-sizing: border-box; font: inherit; padding: 0.5rem; margin: 0.5rem 0; }
  button { padding: 0.5rem 1.25rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Browser-facing page for the Claude Code `setup-token` flow (docs/adr/0027)
 * -- reached via a capability-bearing `flowId` in the URL (no bearer token
 * involved), same "the URL itself is the authorization" posture as
 * `session-page.ts`'s `/sessions/:token`. Shows the authorize link, then a
 * form for pasting back the code Anthropic's site displays after sign-in.
 */
export function renderClaudeAuthPage(opts: { authorizeUrl: string; submitAction: string }): string {
  return shell(
    "Link your Claude account",
    `<h1>Link your Claude account</h1>
<p>Click below, sign in with the Claude account you want this agent to use, and authorize access.</p>
<p><a class="button" href="${escapeHtml(opts.authorizeUrl)}" target="_blank" rel="noopener">Authorize on claude.ai</a></p>
<p>Anthropic will then show you a short code. Paste it below.</p>
<form method="post" action="${escapeHtml(opts.submitAction)}">
  <label for="code">Authorization code</label>
  <input type="text" id="code" name="code" autocomplete="off" required>
  <button type="submit">Submit</button>
</form>`,
  );
}

export function renderClaudeAuthResultPage(opts: { success: boolean; message: string }): string {
  return shell(
    opts.success ? "Claude account linked" : "Linking failed",
    `<h1>${opts.success ? "Claude account linked" : "Linking failed"}</h1>
<p>${escapeHtml(opts.message)}</p>
${opts.success ? "<p>You can close this tab and return to your chat.</p>" : "<p>Please return to your chat and try again.</p>"}`,
  );
}
