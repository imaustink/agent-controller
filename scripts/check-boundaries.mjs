#!/usr/bin/env node
// Enforces the framework / catalog / orchestrator layering from ADR 0047.
//
// Every npm workspace, Go module and Dockerfile directory is assigned to a
// layer by boundaries.json. A unit may depend on its own layer and on the
// layers its layer `allow`s; anything else is a violation. "Depend" means any
// of the ways one directory in this repo can reach into another:
//
//   - package.json dependencies on another workspace's package name
//   - JS/TS import/require specifiers (bare package names and relative paths)
//   - tsconfig*.json relative paths (extends, references, paths)
//   - Go imports of another module's path, and go.mod `replace` targets
//   - Dockerfile COPY/ADD sources naming another unit's directory, resolved
//     against that image's build context: the context skaffold.yaml or
//     .github/release-images.json builds it with, or the repo root when
//     neither mentions it (most images build from the root; a few, like the
//     Go services, build from their own directory)
//
// It also fails when a workspace / module / Dockerfile directory matches no
// unit (so a new component cannot land unclassified) and when a configured
// unit path does not exist (so the config cannot silently go stale after a
// move). Dependency-free on purpose: it runs before `npm ci` would matter.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "bin", "vendor", "coverage", ".turbo"]);
const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;

const toPosix = (p) => p.split(sep).join("/");

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, visit);
    } else if (e.isFile()) {
      visit(full);
    }
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Expands `dir/*` to each existing immediate subdirectory; exact paths pass through. */
function expandPattern(root, pattern) {
  if (!pattern.endsWith("/*")) return [pattern];
  const base = pattern.slice(0, -2);
  const abs = join(root, base);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => `${base}/${e.name}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Maps each Dockerfile (repo-relative) to the build context(s) images are
 * built from it with, per skaffold.yaml and .github/release-images.json.
 *
 * skaffold.yaml is read with a deliberately small line parser rather than a
 * YAML library (this checker stays dependency-free): within each artifact
 * (`- image:`), `context:` and `docker.dockerfile:` -- the only two keys that
 * matter here, with skaffold's defaults `.` and `Dockerfile`.
 */
function dockerBuildContexts(root) {
  const contexts = new Map();
  const add = (dockerfile, context) => {
    const df = posix.normalize(dockerfile);
    const ctx = posix.normalize(context);
    if (!contexts.has(df)) contexts.set(df, new Set());
    contexts.get(df).add(ctx);
  };

  const skaffold = join(root, "skaffold.yaml");
  if (existsSync(skaffold)) {
    let current;
    const flush = () => {
      if (current) add(posix.join(current.context, current.dockerfile), current.context);
    };
    for (const line of readFileSync(skaffold, "utf8").split("\n")) {
      if (/^\s*-\s*image:/.test(line)) {
        flush();
        current = { context: ".", dockerfile: "Dockerfile" };
        continue;
      }
      if (!current) continue;
      const ctx = /^\s*context:\s*["']?([^"'\s#]+)/.exec(line);
      if (ctx) current.context = ctx[1];
      const df = /^\s*dockerfile:\s*["']?([^"'\s#]+)/.exec(line);
      if (df) current.dockerfile = df[1];
    }
    flush();
  }

  const releaseImages = join(root, ".github", "release-images.json");
  if (existsSync(releaseImages)) {
    for (const img of readJson(releaseImages)) {
      if (img.dockerfile) add(img.dockerfile, img.context ?? ".");
    }
  }
  return contexts;
}

/**
 * Runs the check against a repository root. Returns the findings rather than
 * printing, so the test suite can assert on them.
 */
export function checkBoundaries(root, config = readJson(join(root, "boundaries.json"))) {
  const layers = config.layers;
  const errors = [];

  // ---- units -------------------------------------------------------------
  const units = [];
  for (const { path, layer } of config.units) {
    if (!layers[layer]) {
      errors.push({ kind: "config", message: `unit "${path}" names unknown layer "${layer}"` });
      continue;
    }
    const expanded = expandPattern(root, path);
    if (expanded.length === 0 || !expanded.every((p) => existsSync(join(root, p)))) {
      errors.push({ kind: "stale", message: `configured unit "${path}" does not exist` });
      continue;
    }
    for (const p of expanded) units.push({ path: p, layer });
  }
  // Longest path wins, so a nested unit can override its parent's layer.
  units.sort((a, b) => b.path.length - a.path.length);

  const ownerOf = (relPath) => {
    const p = toPosix(relPath);
    return units.find((u) => p === u.path || p.startsWith(`${u.path}/`));
  };

  // ---- components that must be classified ---------------------------------
  const components = new Set();
  const rootPkg = existsSync(join(root, "package.json")) ? readJson(join(root, "package.json")) : {};
  for (const pattern of rootPkg.workspaces ?? []) {
    for (const p of expandPattern(root, pattern)) {
      if (existsSync(join(root, p, "package.json"))) components.add(p);
    }
  }
  walk(root, (file) => {
    const name = file.split(sep).pop();
    if (name === "go.mod" || /^Dockerfile/.test(name)) {
      const dir = toPosix(relative(root, dirname(file)));
      if (dir !== "" && !dir.split("/").includes("testdata")) components.add(dir);
    }
  });
  for (const c of [...components].sort()) {
    if (!ownerOf(c)) {
      errors.push({ kind: "unclassified", message: `"${c}" is not assigned to a layer in boundaries.json` });
    }
  }

  // ---- name → unit maps for package and module references ---------------
  const packageOwner = new Map();
  const goModuleOwner = new Map();
  for (const u of units) {
    const pkgPath = join(root, u.path, "package.json");
    if (existsSync(pkgPath)) {
      const name = readJson(pkgPath).name;
      if (name) packageOwner.set(name, u);
    }
    walk(join(root, u.path), (file) => {
      if (file.endsWith(`${sep}go.mod`)) {
        const m = /^module\s+(\S+)/m.exec(readFileSync(file, "utf8"));
        if (m) goModuleOwner.set(m[1], ownerOf(relative(root, dirname(file))));
      }
    });
  }

  const packageFor = (specifier) => {
    for (const [name, unit] of packageOwner) {
      if (specifier === name || specifier.startsWith(`${name}/`)) return unit;
    }
    return undefined;
  };
  const goModuleFor = (importPath) => {
    let best;
    for (const [mod, unit] of goModuleOwner) {
      if ((importPath === mod || importPath.startsWith(`${mod}/`)) && (!best || mod.length > best.mod.length)) {
        best = { mod, unit };
      }
    }
    return best?.unit;
  };

  // ---- references --------------------------------------------------------
  const violations = [];
  const record = (from, to, file, line, via) => {
    if (!to || to.path === from.path || to.layer === from.layer) return;
    if (layers[from.layer].allow.includes(to.layer)) return;
    violations.push({
      from: from.path,
      fromLayer: from.layer,
      to: to.path,
      toLayer: to.layer,
      file: toPosix(relative(root, file)),
      line,
      via,
    });
  };
  const relativeTarget = (file, spec) => ownerOf(relative(root, resolve(dirname(file), spec)));

  const buildContexts = dockerBuildContexts(root);
  for (const [dockerfile, ctxs] of buildContexts) {
    if (ctxs.size > 1) {
      errors.push({
        kind: "config",
        message: `${dockerfile} is built with different contexts (${[...ctxs].join(", ")}) by skaffold.yaml / release-images.json`,
      });
    }
  }

  for (const unit of units) {
    walk(join(root, unit.path), (file) => {
      // A nested unit's files belong to it, not to this one.
      if (ownerOf(relative(root, file)) !== unit) return;
      const name = file.split(sep).pop();
      const text = readFileSync(file, "utf8");

      if (name === "package.json") {
        const pkg = JSON.parse(text);
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          for (const dep of Object.keys(pkg[field] ?? {})) {
            const idx = text.indexOf(`"${dep}"`);
            record(unit, packageFor(dep), file, idx >= 0 ? lineOf(text, idx) : 1, `${field} "${dep}"`);
          }
        }
      } else if (/^tsconfig.*\.json$/.test(name)) {
        for (const m of text.matchAll(/"(\.\.?\/[^"]*)"/g)) {
          record(unit, relativeTarget(file, m[1]), file, lineOf(text, m.index), `tsconfig path "${m[1]}"`);
        }
      } else if (JS_EXT.test(name) && !name.endsWith(".d.ts")) {
        const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
        for (const m of text.matchAll(re)) {
          const spec = m[1];
          const target = spec.startsWith(".") ? relativeTarget(file, spec) : packageFor(spec);
          record(unit, target, file, lineOf(text, m.index), `import "${spec}"`);
        }
      } else if (name.endsWith(".go")) {
        const blocks = [...text.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)].map((m) => ({ body: m[1], at: m.index }));
        const singles = [...text.matchAll(/^import\s+(?:[\w.]+\s+)?"[^"]+"/gm)].map((m) => ({ body: m[0], at: m.index }));
        for (const { body, at } of [...blocks, ...singles]) {
          for (const m of body.matchAll(/"([^"]+)"/g)) {
            record(unit, goModuleFor(m[1]), file, lineOf(text, at), `go import "${m[1]}"`);
          }
        }
      } else if (name === "go.mod") {
        for (const m of text.matchAll(/=>\s*(\.\.?\/\S+)/g)) {
          record(unit, relativeTarget(file, m[1]), file, lineOf(text, m.index), `go.mod replace "${m[1]}"`);
        }
        for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/\S+)\s+v\S+/gm)) {
          record(unit, goModuleFor(m[1]), file, lineOf(text, m.index), `go.mod require "${m[1]}"`);
        }
      } else if (/^Dockerfile/.test(name)) {
        // COPY sources are relative to the build context, not the repo root.
        const contexts = buildContexts.get(toPosix(relative(root, file))) ?? new Set(["."]);
        for (const m of text.matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gim)) {
          const args = m[1].trim().split(/\s+/);
          if (args.some((a) => a.startsWith("--from"))) continue;
          const sources = args.filter((a) => !a.startsWith("--")).slice(0, -1);
          for (const src of sources) {
            for (const context of contexts) {
              const target = posix.normalize(posix.join(context, src));
              if (target.startsWith("..")) continue; // outside the repo
              const ctxNote = context === "." ? "" : ` (context ${context})`;
              record(unit, ownerOf(target), file, lineOf(text, m.index), `Dockerfile ${src}${ctxNote}`);
            }
          }
        }
      }
    });
  }

  return { errors, violations, units };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { errors, violations, units } = checkBoundaries(root);

  for (const e of errors) console.error(`✗ ${e.kind}: ${e.message}`);
  for (const v of violations) {
    console.error(
      `✗ ${v.file}:${v.line}: ${v.fromLayer} "${v.from}" may not depend on ${v.toLayer} "${v.to}" (${v.via})`,
    );
  }

  if (errors.length || violations.length) {
    console.error(
      `\n${errors.length + violations.length} boundary problem(s). Layers and their allowed dependencies are in boundaries.json (ADR 0047).`,
    );
    process.exit(1);
  }
  const byLayer = {};
  for (const u of units) byLayer[u.layer] = (byLayer[u.layer] ?? 0) + 1;
  const summary = Object.entries(byLayer)
    .map(([l, n]) => `${l}: ${n}`)
    .join(", ");
  console.log(`✓ import boundaries hold (${summary})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
