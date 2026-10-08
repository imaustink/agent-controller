/**
 * Builds src/index.ts into a single self-contained IIFE at dist/owui-form.js.
 *
 * The bundle is inlined into the embed HTML, and that HTML is persisted into
 * Open WebUI's chat database on every message carrying the form -- so its size
 * is a per-message storage cost, not a one-time download. That is why the
 * budget below is enforced as a build failure rather than a warning, and why it
 * matches the `max_bundle_bytes` valve default in tool/helm_values_form.py.
 */

import { build } from "esbuild";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "dist", "owui-form.js");

/**
 * Keep in sync with Valves.max_bundle_bytes in tool/helm_values_form.py and
 * with tests/bundle.test.ts.
 *
 * Raised from 32768 when the renderer gained maps-of-objects, discriminated
 * variants (allOf/if/then), fully recursive cards, and the smaller schema
 * features -- roughly a doubling of the supported schema surface, for about
 * 10 KB. The budget is a real cost (this HTML is stored once per message
 * carrying a form, not downloaded once), so it moved deliberately rather than
 * quietly: 48 KB per form-bearing message is still small next to the message
 * itself, and refusing to render would be the worse failure. If it needs to come
 * back down, the stylesheet is the cheapest ~1 KB -- it ships with its newlines
 * and indentation intact, because esbuild's JS minifier does not touch the
 * contents of a template literal.
 */
export const BUNDLE_BUDGET = 49152;

mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [join(here, "src", "index.ts")],
  bundle: true,
  format: "iife",
  // The one global the shell is allowed to see.
  globalName: "OWUIForm",
  // ES2020 covers optional chaining and nullish coalescing, which the source
  // uses freely, while staying well inside what any browser running Open WebUI
  // supports.
  target: "es2020",
  platform: "browser",
  minify: true,
  // No external anything: a sandboxed iframe with an opaque origin cannot
  // fetch, so the bundle has to be complete on its own.
  external: [],
  legalComments: "none",
  outfile,
  metafile: true,
});

// A second, node-targeted ESM copy of just the value-producing half. The helm
// check drives prune + emit from a script, and it has to be the same code the
// browser runs -- a reimplementation in the test harness would pass while the
// shipped emitter was broken.
await build({
  entryPoints: [join(here, "src", "values.ts")],
  bundle: true,
  format: "esm",
  target: "node20",
  platform: "node",
  outfile: join(here, "dist", "node", "values.mjs"),
});

const bytes = statSync(outfile).size;
writeFileSync(
  join(here, "dist", "meta.json"),
  `${JSON.stringify({ bytes, budget: BUNDLE_BUDGET }, null, 2)}\n`,
);

const pct = ((bytes / BUNDLE_BUDGET) * 100).toFixed(1);
console.log(`dist/owui-form.js  ${bytes} bytes  (${pct}% of the ${BUNDLE_BUDGET}-byte budget)`);

if (result.warnings.length > 0) {
  for (const w of result.warnings) console.warn(`warning: ${w.text}`);
}

if (bytes > BUNDLE_BUDGET) {
  console.error(
    `\nBundle is ${bytes - BUNDLE_BUDGET} bytes over the ${BUNDLE_BUDGET}-byte budget.\n` +
      `This HTML is stored in the chat database once per message, so the budget is real.\n` +
      `Trim src/theme.ts first -- it is the largest single contributor.`,
  );
  process.exit(1);
}
