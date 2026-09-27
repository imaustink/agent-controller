import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfluenceDriver } from "../../apps/connection-broker/src/drivers/confluence.js";
import { PermissionDeniedError } from "../../apps/connection-broker/src/drivers/types.js";

/**
 * The fake Confluence, driven by the REAL Confluence driver.
 *
 * Every cluster spec that indexes a corpus rests on this fake answering what
 * the driver actually asks. If it does not, those specs still pass — against a
 * fiction — and report a working pipeline while the real one is broken. A stub
 * nobody has checked against its original is worse than no stub, because it
 * manufactures confidence.
 *
 * So this extracts the server out of the manifest the cluster deploys, runs
 * it, and points the production driver at it. Needs no cluster and no
 * credentials, which is why it runs in CI beside the contract spec: a fake
 * that has drifted from the driver should fail in seconds on a laptop rather
 * than turn a cluster suite green over nothing.
 *
 * It also pins the security-relevant half of the fixture. Page 102 is visible
 * to the service credential and to one user and not the other, which is what
 * makes "indexed but not readable by this caller" — the case ADR 0040 exists
 * for — expressible at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "..", "manifests", "fake-confluence.yaml");

const SERVICE = "e2e-service-token";
const USER_FULL = "e2e-user-full";
const USER_LIMITED = "e2e-user-limited";
const CLOUD_ID = "e2e-cloud-id";

let child: ChildProcess;
let origin: string;

/**
 * Runs the manifest's own `server.js`, not a copy.
 *
 * A copy is the drift this spec exists to prevent, one level up.
 */
function extractServer(): string {
  const yaml = readFileSync(MANIFEST, "utf8");
  const start = yaml.indexOf("  server.js: |");
  expect(start, "manifest no longer contains a server.js key").toBeGreaterThan(-1);

  const lines = yaml.slice(start).split("\n").slice(1);
  const body: string[] = [];
  for (const line of lines) {
    // The block ends at the first line that is neither blank nor indented
    // past the key — the document separator, in practice.
    if (line.trim() !== "" && !line.startsWith("    ")) break;
    body.push(line.slice(4));
  }
  return body.join("\n");
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-confluence-"));
  const script = join(dir, "server.js");
  writeFileSync(script, extractServer());

  child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  origin = "http://127.0.0.1:8080";

  // Wait for the listener rather than sleeping a guessed interval.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("fake-confluence did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(() => child?.kill());

const driver = () =>
  new ConfluenceDriver({
    gatewayOrigin: origin,
    cloudId: CLOUD_ID,
    siteBaseUrl: "https://fake.atlassian.net/wiki",
  });

const ALPHA = { space: "ALPHA" };

describe("ingestion, on the service credential", () => {
  it("lists a space's pages", async () => {
    const page = await driver().list(ALPHA, { service: SERVICE }, undefined);

    // Both Alpha pages, including the one a limited user cannot read: ingestion
    // deliberately ignores permissions, which is what makes the probe load-bearing.
    expect(page.resources.map((r) => r.id).sort()).toEqual(["101", "102"]);
  });

  it("fetches a page as prose, with macro configuration stripped", async () => {
    const doc = await driver().fetch(ALPHA, { service: SERVICE }, "101");

    expect(doc.markdown).toContain("Deploys run from the release branch.");
    // The bug this fixture deliberately reproduces: a panel's background
    // colour embedded as though a client had written it.
    expect(doc.markdown).not.toContain("E3FCEF");
  });

  it("carries a citation a person can open", async () => {
    const page = await driver().list(ALPHA, { service: SERVICE }, undefined);

    // Built from the configured SITE, never the API host.
    const first = page.resources[0];
    expect(first, "list returned nothing to check a citation on").toBeDefined();
    expect(first!.url).toContain("https://fake.atlassian.net/wiki/spaces/");
    expect(first!.url).not.toContain("127.0.0.1");
  });

  it("refuses a page outside the corpus's space", async () => {
    // 201 exists and the credential can read it; it is simply not in ALPHA.
    await expect(driver().fetch(ALPHA, { service: SERVICE }, "201")).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});

describe("the probe, as the asking user", () => {
  it("allows a page the caller can see", async () => {
    const result = await driver().probe(ALPHA, { delegated: USER_LIMITED }, "101");

    expect(result.allowed).toBe(true);
    expect(result.title).toBe("Alpha Runbook");
  });

  it("refuses a page the caller cannot see, though it IS indexed", async () => {
    // The whole reason the probe exists. 102 is in the corpus — ingestion put
    // it there on the service credential — and this caller must not receive it.
    await expect(driver().probe(ALPHA, { delegated: USER_LIMITED }, "102")).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("allows the same page for a caller who can", async () => {
    // Proves the refusal above is about identity and not about the page being
    // broken or missing — the two are indistinguishable from a single probe.
    const result = await driver().probe(ALPHA, { delegated: USER_FULL }, "102");

    expect(result.allowed).toBe(true);
    expect(result.title).toBe("Alpha Incident Postmortem");
  });

  it("refuses the service credential outright", async () => {
    await expect(driver().probe(ALPHA, { service: SERVICE }, "101")).rejects.toThrow(
      /delegated token/,
    );
  });
});

describe("live search", () => {
  it("is bounded to the corpus's space", async () => {
    const hits = await driver().searchAsUser({ delegated: USER_FULL }, ALPHA, "deploys");

    expect(hits.length).toBeGreaterThan(0);
    // 201 also contains "deploys" and belongs to another client.
    expect(hits.map((h) => h.id)).not.toContain("201");
  });

  it("is bounded by the caller as well as the space", async () => {
    const full = await driver().searchAsUser({ delegated: USER_FULL }, ALPHA, "outage");
    const limited = await driver().searchAsUser({ delegated: USER_LIMITED }, ALPHA, "outage");

    expect(full.map((h) => h.id)).toContain("102");
    expect(limited.map((h) => h.id)).not.toContain("102");
  });

  it("strips the highlight sentinels Confluence wraps matches in", async () => {
    const hits = await driver().searchAsUser({ delegated: USER_FULL }, ALPHA, "deploys");

    expect(hits[0], "search returned nothing to check an excerpt on").toBeDefined();
    expect(hits[0]!.excerpt ?? "").not.toContain("@@@hl@@@");
  });
});

describe("the user read face", () => {
  it("reads a page the caller can see", async () => {
    const doc = await driver().readAsUser({ delegated: USER_LIMITED }, "101");

    expect(doc.markdown).toContain("Roll back with the previous image tag.");
  });

  it("reads OUTSIDE the corpus scope, bounded only by identity", async () => {
    // Deliberate: a citation leads out of the indexed space, and the caller's
    // own token is what bounds this read (ADR 0040).
    const doc = await driver().readAsUser({ delegated: USER_LIMITED }, "201");

    expect(doc.markdown).toContain("two approvers");
  });

  it("still refuses a page the caller cannot see", async () => {
    await expect(driver().readAsUser({ delegated: USER_LIMITED }, "102")).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});
