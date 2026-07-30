/**
 * The form's stylesheet, as a string, injected into a `<style>` element.
 *
 * Light/dark comes from `prefers-color-scheme` and nothing else. The iframe is
 * sandboxed without same-origin access, so Open WebUI's theme class, its CSS
 * variables, localStorage, and cookies are all unreachable from in here -- the
 * browser's own preference is the only signal available.
 *
 * It is also part of the 32 KB bundle budget, and the bundle is persisted into
 * the chat database on every message, so this stays deliberately small: one set
 * of custom properties, one dark override, no resets beyond what is needed.
 */
export const CSS = `
:root{
  --hvf-bg:#fff; --hvf-fg:#18181b; --hvf-muted:#71717a; --hvf-border:#e4e4e7;
  --hvf-field-bg:#fff; --hvf-section-bg:#fafafa; --hvf-accent:#2563eb;
  --hvf-accent-fg:#fff; --hvf-danger:#dc2626; --hvf-danger-bg:#fef2f2;
  --hvf-ghost-bg:#f4f4f5;
}
@media (prefers-color-scheme:dark){
  :root{
    --hvf-bg:#18181b; --hvf-fg:#f4f4f5; --hvf-muted:#a1a1aa; --hvf-border:#3f3f46;
    --hvf-field-bg:#27272a; --hvf-section-bg:#1f1f23; --hvf-accent:#3b82f6;
    --hvf-accent-fg:#fff; --hvf-danger:#f87171; --hvf-danger-bg:#2a1616;
    --hvf-ghost-bg:#27272a;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--hvf-bg);color:var(--hvf-fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.hvf{padding:16px;max-width:760px}
.hvf-h{font-size:16px;font-weight:600;margin:0 0 2px}
.hvf-sub{color:var(--hvf-muted);margin:0 0 14px;font-size:13px}

.hvf-sec{border:1px solid var(--hvf-border);border-radius:8px;margin:0 0 10px;
  background:var(--hvf-section-bg);overflow:hidden}
.hvf-sec>summary{cursor:pointer;padding:9px 12px;font-weight:600;font-size:13px;
  list-style:none;display:flex;align-items:center;gap:6px;user-select:none}
.hvf-sec>summary::-webkit-details-marker{display:none}
.hvf-sec>summary::before{content:"";border:4px solid transparent;
  border-left-color:var(--hvf-muted);transform:translateX(1px);transition:transform .12s}
.hvf-sec[open]>summary::before{transform:rotate(90deg) translateY(-1px)}
.hvf-sec>summary:focus-visible{outline:2px solid var(--hvf-accent);outline-offset:-2px}
.hvf-secbody{padding:4px 12px 12px;border-top:1px solid var(--hvf-border)}
.hvf-secpath{color:var(--hvf-muted);font-weight:400;font-size:11px}

.hvf-f{margin:12px 0}
.hvf-l{display:block;font-weight:500;margin-bottom:3px}
.hvf-req{color:var(--hvf-danger);margin-left:2px}
.hvf-help{color:var(--hvf-muted);font-size:12px;margin:2px 0 5px}
.hvf-in,.hvf-sel{width:100%;padding:6px 8px;border:1px solid var(--hvf-border);
  border-radius:6px;background:var(--hvf-field-bg);color:var(--hvf-fg);
  font:inherit;min-width:0}
.hvf-in:focus,.hvf-sel:focus{outline:2px solid var(--hvf-accent);outline-offset:-1px;
  border-color:var(--hvf-accent)}
.hvf-in:disabled,.hvf-sel:disabled{opacity:.55;cursor:not-allowed}
.hvf-in.hvf-bad,.hvf-sel.hvf-bad{border-color:var(--hvf-danger)}
.hvf-e{color:var(--hvf-danger);font-size:12px;margin-top:3px;display:none}
.hvf-e.hvf-on{display:block}

.hvf-cbrow{display:flex;align-items:center;gap:8px}
.hvf-cbrow input{width:15px;height:15px;accent-color:var(--hvf-accent);margin:0;flex:none}
.hvf-cbrow .hvf-l{margin:0}
.hvf-null{display:inline-flex;align-items:center;gap:4px;color:var(--hvf-muted);
  font-size:12px;margin-top:4px;cursor:pointer}
.hvf-null input{width:13px;height:13px;margin:0;accent-color:var(--hvf-accent)}

.hvf-row{display:flex;gap:6px;align-items:flex-start;margin-bottom:6px}
.hvf-row .hvf-in{flex:1}
.hvf-card{border:1px solid var(--hvf-border);border-radius:6px;padding:2px 10px 10px;
  margin-bottom:8px;background:var(--hvf-bg);position:relative}
.hvf-cardhd{display:flex;justify-content:space-between;align-items:center;
  padding-top:8px;color:var(--hvf-muted);font-size:11px;text-transform:uppercase;
  letter-spacing:.04em}
.hvf-cardlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hvf-ta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  resize:vertical;display:block}
/* The variant field set is replaced wholesale when the discriminator changes;
   the rule exists so an empty one adds no stray spacing. */
.hvf-variant:empty{display:none}

.hvf-b{font:inherit;border-radius:6px;cursor:pointer;padding:6px 10px;
  border:1px solid var(--hvf-border);background:var(--hvf-ghost-bg);color:var(--hvf-fg)}
.hvf-b:hover{border-color:var(--hvf-muted)}
.hvf-b:focus-visible{outline:2px solid var(--hvf-accent);outline-offset:1px}
.hvf-x{flex:none;padding:6px 9px;line-height:1;color:var(--hvf-muted)}
.hvf-x:hover{color:var(--hvf-danger);border-color:var(--hvf-danger)}
.hvf-add{font-size:13px;padding:4px 9px}
.hvf-empty{color:var(--hvf-muted);font-size:12px;font-style:italic;margin:0 0 6px}

.hvf-foot{display:flex;align-items:center;gap:10px;margin-top:16px;
  padding-top:14px;border-top:1px solid var(--hvf-border)}
.hvf-submit{background:var(--hvf-accent);color:var(--hvf-accent-fg);
  border-color:transparent;font-weight:600;padding:8px 16px}
.hvf-submit:hover{filter:brightness(1.08)}
.hvf-summary{color:var(--hvf-danger);font-size:13px}

.hvf-banner{border:1px solid var(--hvf-danger);background:var(--hvf-danger-bg);
  color:var(--hvf-danger);border-radius:8px;padding:11px 13px;margin-bottom:12px}
.hvf-banner b{display:block;margin-bottom:4px}
.hvf-banner ul{margin:6px 0 0;padding-left:20px}
.hvf-banner code,.hvf-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
`;
