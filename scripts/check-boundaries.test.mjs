// Every rule in check-boundaries.mjs is proven here to FAIL on a fixture that
// breaks it, not only to pass on the real repo: a boundary check that cannot go
// red reads as coverage and protects nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkBoundaries } from "./check-boundaries.mjs";

const CONFIG = {
  layers: {
    framework: { allow: [] },
    catalog: { allow: ["framework"] },
    orchestrator: { allow: ["framework"] },
  },
  units: [
    { path: "packages/proto", layer: "framework" },
    { path: "tools/*", layer: "catalog" },
    { path: "apps/orch", layer: "orchestrator" },
    { path: "engine", layer: "orchestrator" },
  ],
};

const BASE = {
  "package.json": JSON.stringify({ workspaces: ["packages/*", "tools/*", "apps/*"] }),
  "packages/proto/package.json": JSON.stringify({ name: "@x/proto" }),
  "packages/proto/src/index.ts": "export const a = 1;\n",
  "tools/search/package.json": JSON.stringify({ name: "@x/search", dependencies: { "@x/proto": "1" } }),
  "tools/search/src/index.ts": 'import { a } from "@x/proto";\n',
  "apps/orch/package.json": JSON.stringify({ name: "@x/orch", dependencies: { "@x/proto": "1" } }),
  "apps/orch/src/index.ts": 'import { a } from "@x/proto/sub";\n',
  "engine/go.mod": "module example.com/engine\n\ngo 1.22\n",
  "engine/main.go": 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println() }\n',
};

function fixture(overrides = {}, config = CONFIG) {
  const root = mkdtempSync(join(tmpdir(), "boundaries-"));
  const files = { ...BASE, "boundaries.json": JSON.stringify(config), ...overrides };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(overrides, config) {
  const root = fixture(overrides, config);
  try {
    return checkBoundaries(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the baseline fixture is clean", () => {
  const { errors, violations } = run();
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
});

test("framework importing the orchestrator by package name fails", () => {
  const { violations } = run({ "packages/proto/src/index.ts": 'import { x } from "@x/orch";\n' });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, "packages/proto");
  assert.equal(violations[0].to, "apps/orch");
  assert.equal(violations[0].line, 1);
});

test("a package.json dependency across the boundary fails even with no import", () => {
  const { violations } = run({
    "packages/proto/package.json": JSON.stringify({ name: "@x/proto", devDependencies: { "@x/search": "1" } }),
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0].via, /devDependencies "@x\/search"/);
});

test("catalog and orchestrator may not depend on each other in either direction", () => {
  const one = run({ "tools/search/src/index.ts": 'export * from "@x/orch";\n' });
  assert.equal(one.violations.length, 1);
  assert.equal(one.violations[0].toLayer, "orchestrator");

  const other = run({ "apps/orch/src/index.ts": 'const s = require("@x/search");\n' });
  assert.equal(other.violations.length, 1);
  assert.equal(other.violations[0].toLayer, "catalog");
});

test("relative imports that climb into another unit are resolved and checked", () => {
  const { violations } = run({ "packages/proto/src/index.ts": 'import "../../../apps/orch/src/index.js";\n' });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].to, "apps/orch");
});

test("dynamic import() is checked", () => {
  const { violations } = run({ "packages/proto/src/lazy.ts": 'export const m = () => import("@x/orch");\n' });
  assert.equal(violations.length, 1);
});

test("tsconfig relative paths into another unit fail", () => {
  const { violations } = run({
    "packages/proto/tsconfig.json": JSON.stringify({ references: [{ path: "../../apps/orch" }] }),
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0].via, /tsconfig/);
});

test("Go imports of another unit's module path fail", () => {
  const { violations } = run({
    "packages/proto/go.mod": "module example.com/proto\n\ngo 1.22\n",
    "packages/proto/gen.go": 'package proto\n\nimport (\n\t"fmt"\n\teng "example.com/engine/internal/x"\n)\n',
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0].via, /go import "example.com\/engine\/internal\/x"/);
});

test("a go.mod replace pointing into another unit fails", () => {
  const { violations } = run({
    "packages/proto/go.mod": "module example.com/proto\n\ngo 1.22\n\nreplace example.com/engine => ../../engine\n",
  });
  assert.ok(violations.some((v) => v.via.startsWith("go.mod replace") && v.to === "engine"));
});

test("a go.mod require of another unit's module path fails", () => {
  const { violations } = run({
    "packages/proto/go.mod": "module example.com/proto\n\ngo 1.22\n\nrequire example.com/engine v0.0.0\n",
  });
  assert.ok(violations.some((v) => v.via.startsWith("go.mod require") && v.to === "engine"));
});

test("Go imports in the allowed direction pass", () => {
  const { violations } = run({
    "packages/proto/go.mod": "module example.com/proto\n\ngo 1.22\n",
    "engine/use.go": 'package main\n\nimport "example.com/proto/gen"\n',
  });
  assert.deepEqual(violations, []);
});

test("a Dockerfile COPYing another unit's directory fails; --from stages are ignored", () => {
  const { violations } = run({
    "tools/search/Dockerfile":
      "FROM node:22\nCOPY packages/proto packages/proto\nCOPY apps/orch/src ./src\nCOPY --from=build apps/orch/dist ./dist\n",
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].to, "apps/orch");
  assert.equal(violations[0].line, 3);
});

// The engine's Dockerfile COPYs a path whose first segments name a catalog
// unit (tools/search). Built from the repo root that IS a cross-layer
// reference; built from its own directory it is the engine's own file.
const ENGINE_COPY = { "engine/Dockerfile": "FROM golang\nCOPY tools/search ./vendored\n" };
const ENGINE_OWN_CONTEXT_SKAFFOLD =
  "build:\n  artifacts:\n    - image: engine\n      context: engine\n      docker:\n        dockerfile: Dockerfile\n";

test("a COPY is resolved against the repo root when no build config names the image's context", () => {
  const { violations } = run(ENGINE_COPY);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].to, "tools/search");
});

test("a COPY is resolved against the build context skaffold.yaml declares", () => {
  const { errors, violations } = run({ ...ENGINE_COPY, "skaffold.yaml": ENGINE_OWN_CONTEXT_SKAFFOLD });
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
});

test("a COPY is resolved against the build context .github/release-images.json declares", () => {
  const { violations } = run({
    ...ENGINE_COPY,
    ".github/release-images.json": JSON.stringify([{ image: "engine", dockerfile: "engine/Dockerfile", context: "engine" }]),
  });
  assert.deepEqual(violations, []);
});

test("a context-relative COPY that really leaves its context into another unit still fails", () => {
  const { violations } = run({
    "engine/Dockerfile": "FROM golang\nCOPY ../apps/orch/x ./x\nCOPY ../tools/search ./y\n",
    "skaffold.yaml": ENGINE_OWN_CONTEXT_SKAFFOLD,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].to, "tools/search");
  assert.match(violations[0].via, /context engine/);
});

test("a Dockerfile built with different contexts by different configs is reported", () => {
  const { errors } = run({
    ...ENGINE_COPY,
    "skaffold.yaml": ENGINE_OWN_CONTEXT_SKAFFOLD,
    ".github/release-images.json": JSON.stringify([{ image: "engine", dockerfile: "engine/Dockerfile", context: "." }]),
  });
  assert.ok(errors.some((e) => e.kind === "config" && e.message.includes("engine/Dockerfile")));
});

test("a workspace that matches no unit is reported", () => {
  const { errors } = run({ "apps/newthing/package.json": JSON.stringify({ name: "@x/newthing" }) });
  assert.ok(errors.some((e) => e.kind === "unclassified" && e.message.includes("apps/newthing")));
});

test("a Go module or Dockerfile directory outside every unit is reported", () => {
  const { errors } = run({ "sidecars/exec/go.mod": "module example.com/exec\n", "misc/Dockerfile": "FROM x\n" });
  const unclassified = errors.filter((e) => e.kind === "unclassified").map((e) => e.message);
  assert.ok(unclassified.some((m) => m.includes("sidecars/exec")));
  assert.ok(unclassified.some((m) => m.includes("misc")));
});

test("a configured unit that no longer exists is reported, so a move cannot leave the config stale", () => {
  const config = { ...CONFIG, units: [...CONFIG.units, { path: "apps/gone", layer: "orchestrator" }] };
  const { errors } = run({}, config);
  assert.ok(errors.some((e) => e.kind === "stale" && e.message.includes("apps/gone")));
});

test("an unknown layer name in the config is reported", () => {
  const config = { ...CONFIG, units: [...CONFIG.units, { path: "engine", layer: "orchestrater" }] };
  const { errors } = run({}, config);
  assert.ok(errors.some((e) => e.kind === "config"));
});

test("a nested unit overrides its parent's layer", () => {
  const config = {
    ...CONFIG,
    units: [...CONFIG.units, { path: "apps/orch/sdk", layer: "framework" }],
  };
  const { violations } = run(
    {
      "apps/orch/sdk/package.json": JSON.stringify({ name: "@x/orch-sdk" }),
      "apps/orch/sdk/index.ts": 'import "@x/orch";\n',
    },
    config,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, "apps/orch/sdk");
  assert.equal(violations[0].fromLayer, "framework");
});
