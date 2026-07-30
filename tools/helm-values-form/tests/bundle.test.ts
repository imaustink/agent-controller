/**
 * Assertions about the built artifact rather than the source.
 *
 * These need `npm run build` to have run first, which `npm test` does. They are
 * cheap and they guard the two things that only show up after bundling: the size
 * that gets persisted per chat message, and whether the IIFE really exposes one
 * global and nothing external.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "dist", "owui-form.js");

/** Matches Valves.max_bundle_bytes in tool/helm_values_form.py and build.mjs. */
const BUDGET = 49152;

describe("the built bundle", () => {
  it("exists (run `npm run build` first)", () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("is under the byte budget the Python tool enforces", () => {
    const bytes = Buffer.byteLength(readFileSync(bundlePath, "utf8"), "utf8");
    expect(bytes).toBeLessThanOrEqual(BUDGET);
  });

  it("agrees with the size build.mjs recorded", () => {
    const meta = JSON.parse(readFileSync(join(root, "dist", "meta.json"), "utf8"));
    expect(meta.budget).toBe(BUDGET);
    expect(meta.bytes).toBe(Buffer.byteLength(readFileSync(bundlePath, "utf8"), "utf8"));
  });

  it("exposes OWUIForm.render and nothing that needs the network", () => {
    const src = readFileSync(bundlePath, "utf8");
    expect(src).toContain("OWUIForm");
    for (const forbidden of ["import(", "require(", "fetch(", "XMLHttpRequest", "importScripts"]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("contains no closing script tag, which would end the inline script early", () => {
    expect(readFileSync(bundlePath, "utf8").toLowerCase()).not.toContain("</script");
  });

  it("really is minified into a single IIFE", () => {
    const src = readFileSync(bundlePath, "utf8");
    expect(src).toContain("var OWUIForm=(()=>{");
    // Line count is not a minification signal here: the stylesheet in
    // src/theme.ts is a template literal full of real newlines, so the file has
    // as many lines as the CSS does. Indented statements are the tell instead.
    expect(/\n\s{2,}(?:const|function|return) /.test(src)).toBe(false);
  });

  it("evaluates in a browser-ish global and renders a form end to end", () => {
    // The last thing unit tests on src/ cannot check: that the *bundled* code
    // still works after minification and IIFE wrapping.
    const src = readFileSync(bundlePath, "utf8");
    const sandbox = { document, window: globalThis } as Record<string, unknown>;
    const factory = new Function("document", "window", `${src}; return OWUIForm;`);
    const api = factory(sandbox.document, sandbox.window) as {
      render: (r: HTMLElement, c: unknown, cb: (y: string) => void) => void;
    };

    const host = document.createElement("div");
    document.body.appendChild(host);
    let emitted = "";
    api.render(
      host,
      {
        chart: "temporal-worker",
        schema: {
          type: "object",
          properties: {
            image: { type: "object", properties: { tag: { type: "string", default: "0.1.0" } } },
          },
        },
      },
      (yaml: string) => {
        emitted = yaml;
      },
    );

    host.querySelector<HTMLInputElement>("#hvf-image_tag")!.value = "9.9.9";
    host.querySelector<HTMLButtonElement>(".hvf-submit")!.click();
    expect(emitted).toContain("image:\n  tag: 9.9.9");
  });
});
