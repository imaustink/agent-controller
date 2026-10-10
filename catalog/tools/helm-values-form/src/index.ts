/**
 * Bundle entry point.
 *
 * esbuild wraps this as an IIFE assigned to `OWUIForm` (see build.mjs), so the
 * shell calls `OWUIForm.render(root, cfg, onSubmit)` and nothing else is
 * exposed. There is no module loading at runtime: the bundle is inlined into
 * the HTML because a sandboxed iframe without same-origin access has an opaque
 * origin, and its `import()` requests would go out with `Origin: null`.
 */

export { render } from "./render.js";
export type { FormConfig, Json, JSONSchema, SubmitHandler } from "./types.js";
