/**
 * The end-to-end check: does this actually produce a valid Helm values file?
 *
 * Unit tests on the emitter can only assert that it emits what we think it
 * should. This drives the real prune and the real emitter from a scripted set of
 * form inputs, hands the result to Helm, and diffs the rendered manifests
 * against a golden file. One test, three bug classes -- quoting, pruning, and
 * nesting -- because all three surface as either a schema validation failure or
 * a changed manifest.
 *
 *   node scripts/helm-check.mjs            verify against the goldens
 *   node scripts/helm-check.mjs --update   regenerate the goldens
 *
 * Requires `npm run build` (for dist/node/values.mjs) and a `helm` binary.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { deepEqual, emitYaml, resolveRef, valuesYaml } from "../dist/node/values.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const chartDir = join(root, "charts", "temporal-worker");
const goldenDir = join(root, "tests", "golden");
const tmpDir = join(root, "dist", "helm-check");

const UPDATE = process.argv.includes("--update");
const RELEASE = "rel";

const failures = [];
const notes = [];

function fail(what, detail) {
  failures.push(`${what}\n${detail}`);
}

function helm(args) {
  return execFileSync("helm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Scripted form inputs: what render.ts collects from the controls, before
 * pruning. Written as full values (defaults included) because that is what a
 * form submits -- every control reports its value, and prune.ts is what decides
 * which ones matter.
 *
 * One deliberate exception: the empty `value` on an extraEnv entry is something
 * the renderer would drop from the card before submitting. It is here because
 * prune treats arrays as atomic, so it survives to the emitter and exercises
 * `''` quoting inside a sequence of maps -- which nothing else covers.
 */
const CASES = [
  {
    name: "acceptance",
    // The scenario from the acceptance criteria: override the image tag and the
    // memory limit, leave everything else alone.
    inputs: {
      replicaCount: 1,
      image: { tag: "1.42.3" },
      temporal: { namespace: "default", taskQueue: "worker-tq" },
      resources: { limits: { cpu: "500m", memory: "1Gi" } },
      podAnnotations: {},
    },
    expectOverrides: { image: { tag: "1.42.3" }, resources: { limits: { memory: "1Gi" } } },
    // Equivalent --set flags. These stay strings under Helm's --set type
    // inference: "1.42.3" has two dots and "1Gi" is not numeric, so neither is
    // coerced. A tag like "1.10" would become the float 1.1 and this comparison
    // would fail for a reason that is Helm's, not ours -- which is exactly why
    // the README tells you to prefer -f over --set.
    setFlags: ["image.tag=1.42.3", "resources.limits.memory=1Gi"],
  },
  {
    name: "full",
    // Everything the form can emit, including the quoting hazards. The
    // annotation values "true" and "yes" are the important ones: emitted bare,
    // YAML 1.1 makes them booleans, and the chart's own schema
    // (additionalProperties: {type: string}) rejects the file.
    inputs: {
      replicaCount: 3,
      image: { repository: "ghcr.io/example/temporal-worker", tag: "2024-01-15", pullPolicy: "Always" },
      temporal: {
        hostPort: "temporal-frontend.temporal.svc.cluster.local:7233",
        namespace: "production",
        taskQueue: "orders-v2",
        maxConcurrentActivities: 250,
        tls: { enabled: true, secretName: "temporal-client-tls" },
      },
      resources: {
        limits: { cpu: "2", memory: "4Gi" },
        requests: { cpu: "100m", memory: "128Mi" },
      },
      podAnnotations: {
        "prometheus.io/scrape": "true",
        "prometheus.io/port": "9090",
        "example.com/note": "yes",
        "example.com/owner": "platform-team",
      },
      nodeSelector: { "kubernetes.io/os": "linux" },
      extraArgs: ["--verbose", "--max-poll=10"],
      extraEnv: [
        { name: "LOG_LEVEL", value: "debug" },
        { name: "FEATURE_FLAG", value: "off" },
        { name: "EMPTY_OK", value: "" },
      ],
      serviceAccount: { create: true, name: "temporal-worker-sa" },
    },
  },
];

// --- 0. the sidecar schema must match the chart it claims to describe --------

const sidecarPath = join(root, "charts", "temporal-worker.schema.json");
const chartSchemaPath = join(chartDir, "values.schema.json");
const sidecarRaw = readFileSync(sidecarPath, "utf8");
if (readFileSync(chartSchemaPath, "utf8") !== sidecarRaw) {
  fail(
    "charts/temporal-worker.schema.json has drifted from the chart's values.schema.json",
    "The sidecar is meant to be a copy. Re-copy it:\n" +
      "  cp charts/temporal-worker/values.schema.json charts/temporal-worker.schema.json",
  );
}
const schema = JSON.parse(sidecarRaw);

// --- 1. the chart's defaults must match the schema's ------------------------
// prune.ts decides what to emit by comparing against schema defaults, so a
// values.yaml that disagrees makes the form either omit a real override or emit
// a redundant one. Neither is visible in a unit test.

const chartValues = parseYaml(readFileSync(join(chartDir, "values.yaml"), "utf8"), {
  version: "1.1",
});

function checkDefaults(node, path) {
  const resolved = resolveRef(node, schema);
  if (!resolved) return;
  if (resolved.default !== undefined && path.length > 0) {
    let actual = chartValues;
    for (const seg of path) {
      actual = actual === null || actual === undefined ? undefined : actual[seg];
    }
    if (!deepEqual(actual, resolved.default)) {
      fail(
        `values.yaml disagrees with the schema default at ${path.join(".")}`,
        `  schema:      ${JSON.stringify(resolved.default)}\n` +
          `  values.yaml: ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const [key, child] of Object.entries(resolved.properties ?? {})) {
    checkDefaults(child, [...path, key]);
  }
}
checkDefaults(schema, []);

// --- 2. emit, lint, template, diff ------------------------------------------

mkdirSync(tmpDir, { recursive: true });
mkdirSync(goldenDir, { recursive: true });

for (const testCase of CASES) {
  const { yaml, overrides } = valuesYaml(testCase.inputs, schema, {
    chart: "temporal-worker",
    chartVersion: "0.1.0",
  });

  if (testCase.expectOverrides && !deepEqual(overrides, testCase.expectOverrides)) {
    fail(
      `[${testCase.name}] pruning kept the wrong paths`,
      `  expected: ${JSON.stringify(testCase.expectOverrides)}\n` +
        `  got:      ${JSON.stringify(overrides)}`,
    );
  }

  const valuesPath = join(tmpDir, `${testCase.name}.values.yaml`);
  writeFileSync(valuesPath, `${yaml}\n`);

  // helm lint runs the chart's values.schema.json against the merged values.
  // This is where an unquoted "true" in podAnnotations gets caught.
  try {
    helm(["lint", chartDir, "-f", valuesPath]);
  } catch (err) {
    fail(
      `[${testCase.name}] helm lint rejected the emitted values`,
      indent(`${err.stdout ?? ""}${err.stderr ?? ""}`) + `\nvalues file:\n${indent(yaml)}`,
    );
    continue;
  }

  let rendered;
  try {
    rendered = helm(["template", RELEASE, chartDir, "-f", valuesPath]);
  } catch (err) {
    fail(
      `[${testCase.name}] helm template failed`,
      indent(`${err.stdout ?? ""}${err.stderr ?? ""}`),
    );
    continue;
  }

  const goldenPath = join(goldenDir, `${testCase.name}.yaml`);
  const golden = `# Rendered by scripts/helm-check.mjs from the ${testCase.name} case.\n` +
    `# Regenerate with: npm run helm-check:update\n` +
    `#\n# Values file the form produced:\n` +
    `${yaml.split("\n").map((l) => `#   ${l}`.trimEnd()).join("\n")}\n` +
    rendered;

  if (UPDATE) {
    writeFileSync(goldenPath, golden);
    notes.push(`updated tests/golden/${testCase.name}.yaml`);
  } else if (!existsSync(goldenPath)) {
    fail(
      `[${testCase.name}] no golden file`,
      `Create it with: npm run helm-check:update`,
    );
  } else {
    const existing = readFileSync(goldenPath, "utf8");
    if (existing !== golden) {
      fail(
        `[${testCase.name}] rendered manifests differ from tests/golden/${testCase.name}.yaml`,
        indent(firstDiff(existing, golden)),
      );
    }
  }

  // --- 3. -f and the equivalent --set must agree ---------------------------
  if (testCase.setFlags) {
    const viaSet = helm([
      "template",
      RELEASE,
      chartDir,
      ...testCase.setFlags.flatMap((f) => ["--set", f]),
    ]);
    if (viaSet !== rendered) {
      fail(
        `[${testCase.name}] the values file and the equivalent --set flags render differently`,
        indent(firstDiff(viaSet, rendered)),
      );
    }
  }
}

// --- 4. the emitted YAML must round-trip through a real parser --------------

for (const testCase of CASES) {
  const { yaml, overrides } = valuesYaml(testCase.inputs, schema, { chart: "temporal-worker" });
  // YAML 1.1, because that is the resolver Helm uses.
  const reparsed = parseYaml(yaml, { version: "1.1" });
  const normalized = Object.keys(overrides).length === 0 ? {} : overrides;
  if (!deepEqual(reparsed ?? {}, normalized)) {
    fail(
      `[${testCase.name}] the emitted YAML does not parse back to what was pruned`,
      `  pruned:   ${JSON.stringify(normalized)}\n  reparsed: ${JSON.stringify(reparsed)}`,
    );
  }
  // And emitting twice must be byte-identical, or the golden diffs above are
  // noise rather than signal.
  if (emitYaml(overrides) !== emitYaml(overrides)) {
    fail(`[${testCase.name}] emission is not deterministic`, "");
  }
}

function indent(text) {
  return String(text)
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

function firstDiff(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return [
        `first difference at line ${i + 1}:`,
        `  golden: ${JSON.stringify(al[i] ?? "<eof>")}`,
        `  actual: ${JSON.stringify(bl[i] ?? "<eof>")}`,
      ].join("\n");
    }
  }
  return "(files differ only in length)";
}

for (const note of notes) console.log(note);

if (failures.length > 0) {
  console.error(`\nhelm-check failed (${failures.length}):\n`);
  for (const f of failures) console.error(`- ${f}\n`);
  process.exit(1);
}

console.log(`helm-check passed: ${CASES.length} cases linted, templated, and diffed.`);
