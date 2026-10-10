import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No Helm values file may declare the same key twice at the same level.
 *
 * YAML does not merge duplicate mapping keys — the last one wins and the
 * earlier one is discarded, silently, with no warning from Helm or from any
 * linter in this repo. Appending to a values file is therefore only safe for a
 * key that is not already present, which is not a property anyone can hold in
 * their head across a 400-line file.
 *
 * This shipped: `values-e2e.yaml` grew a second `agent-orchestrator:` block
 * for the knowledge-base wiring, which deleted the first one entirely —
 * identityLink, the config block, the static identity map. The orchestrator
 * then logged "knowledge bases are enabled but AGENT_CONNECTION_BROKER_URL or
 * the identity-link gateway is unset" while that variable was plainly set,
 * because it was the OTHER half of the condition that had been removed. Four
 * e2e tests failed as "I'm unable to access the alpha knowledge base", which
 * reads as a product bug and was a values-file bug two layers away.
 *
 * Needs no cluster: it is a property of the files, and it should fail in
 * milliseconds rather than after a deploy.
 */

const CHARTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "orchestrator", "charts");

/** Every values file under charts/, including subcharts. */
function valuesFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // `charts/*/charts/` holds vendored .tgz dependencies too; only the
    // unpacked ones matter and those are ours.
    if (entry.isDirectory()) found.push(...valuesFiles(path));
    else if (/^values.*\.ya?ml$/.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Duplicate keys, by indentation depth.
 *
 * Deliberately a scanner rather than a YAML parse: every parser resolves the
 * duplicate silently, which is the behaviour under test. It only considers
 * plain `key:` lines, skipping list items, comments and block scalars, because
 * a false positive here would be worse than a missed one — it would train
 * somebody to ignore the check.
 */
function duplicateKeys(yaml: string): string[] {
  const seen = new Map<string, Set<string>>();
  const duplicates: string[] = [];

  let blockScalarIndent: number | undefined;

  for (const raw of yaml.split("\n")) {
    const indent = raw.length - raw.trimStart().length;

    // Inside a `|` or `>` block, nothing is structure.
    if (blockScalarIndent !== undefined) {
      if (raw.trim() === "" || indent > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }

    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("- ")) continue;

    const match = /^([A-Za-z0-9_.\-"']+)\s*:(\s|$)/.exec(line);
    if (!match) continue;

    if (/:\s*[|>][-+0-9]*\s*$/.test(line)) blockScalarIndent = indent;

    const key = match[1]!;
    // A nested map resets every deeper scope: `a.b` and `c.b` are not a clash.
    for (const depth of [...seen.keys()]) {
      if (Number(depth) > indent) seen.delete(depth);
    }

    const atDepth = seen.get(String(indent)) ?? new Set<string>();
    // Only top-level and first-level keys are checked. Deeper than that, the
    // scope tracking above is not reliable enough to assert on, and the damage
    // is correspondingly smaller.
    if (indent <= 2) {
      if (atDepth.has(key)) duplicates.push(`${key} (indent ${indent})`);
      atDepth.add(key);
    }
    seen.set(String(indent), atDepth);
  }

  return duplicates;
}

describe("Helm values files", () => {
  const files = valuesFiles(CHARTS);

  it("finds values files to check", () => {
    // A traversal that silently matched nothing would pass forever.
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((f) => [f.slice(CHARTS.length + 1), f]))(
    "%s declares no key twice",
    (_name, path) => {
      const duplicates = duplicateKeys(readFileSync(path, "utf8"));

      expect(
        duplicates,
        `duplicate keys silently discard everything under the earlier one: ${duplicates.join(", ")}`,
      ).toEqual([]);
    },
  );

  it("detects the shape that shipped", () => {
    // The check itself, checked. A scanner that matched nothing would pass
    // every file above and prove nothing at all.
    const broken = [
      "agent-orchestrator:",
      "  identityLink:",
      "    enabled: true",
      "agent-orchestrator:",
      "  knowledgeBases:",
      "    enabled: true",
    ].join("\n");

    expect(duplicateKeys(broken)).toContain("agent-orchestrator (indent 0)");
  });

  it("does not flag the same key under different parents", () => {
    const fine = [
      "agent-orchestrator:",
      "  image:",
      "    tag: a",
      "core-controller:",
      "  image:",
      "    tag: b",
    ].join("\n");

    expect(duplicateKeys(fine)).toEqual([]);
  });

  it("ignores repeated keys inside a block scalar", () => {
    // A ConfigMap-mounted script or a literal block is text, not structure.
    const fine = ["data:", "  server.js: |", "    const a = 1;", "    const a = 2;"].join("\n");

    expect(duplicateKeys(fine)).toEqual([]);
  });
});
