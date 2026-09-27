import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const SAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../controllers/core-controller/config/samples",
);

/**
 * Loads a committed sample manifest.
 *
 * The harnesses read the REAL samples rather than building CR objects inline,
 * for two reasons. Scope belongs in a CRD, so a harness that hand-builds one is
 * testing a shape nobody deploys. And a sample that drifts from what the driver
 * needs is a bug that only shows up when an operator copies it — which has
 * already happened once, when the Confluence sample lost the fields the driver
 * required.
 */
export function loadSample(filename) {
  return yaml.load(readFileSync(join(SAMPLES, filename), "utf8"));
}

/**
 * Overrides a manifest's real-world values with the ones under test.
 *
 * The samples name Bitovi's actual channel and space, which are the right thing
 * to commit but not necessarily what somebody is pointing a harness at. This
 * keeps the committed manifest authoritative for SHAPE while letting the env
 * file decide WHICH subset.
 */
export function withScope(corpus, scope) {
  return { ...corpus, spec: { ...corpus.spec, scope: { ...corpus.spec.scope, ...scope } } };
}

/** Same, for a Connection's site. */
export function withSite(connection, site) {
  const existing = connection.spec.site ?? {};
  return { ...connection, spec: { ...connection.spec, site: { ...existing, ...site } } };
}

/**
 * A SecretReader backed by the env file.
 *
 * The ONE seam a harness substitutes. Everything downstream of it — the join,
 * the cap check, driver construction — is the code that ships, so a harness
 * failure here is ours rather than an artifact of test scaffolding.
 */
export function envSecretReader(value) {
  return async () => value;
}
