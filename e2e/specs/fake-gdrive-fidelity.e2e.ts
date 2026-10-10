import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFake, type FakeProvider } from "../support/fake-provider.js";
import { GDriveDriver } from "../../orchestrator/apps/connection-broker/src/drivers/gdrive.js";
import { PermissionDeniedError } from "../../orchestrator/apps/connection-broker/src/drivers/types.js";

/**
 * The fake Drive, driven by the REAL Drive driver.
 *
 * Every behaviour pinned here was found broken against a live Drive, and each
 * failed the same way: the corpus quietly held less than it claimed, with
 * nothing anywhere reporting a problem.
 *
 *   - listing one level while the corpus is recursive (two of two nested
 *     documents missing)
 *   - skipping every shortcut, of which a real Drive had 54, all pointing at
 *     ordinary Docs
 *   - keying a shortcut on its own version, which never changes when the
 *     target is edited
 *   - dropping PDFs entirely
 *
 * Needs no cluster and no credentials.
 */

const SERVICE = "e2e-gdrive-service";
const USER_FULL = "e2e-gdrive-user-full";
const USER_LIMITED = "e2e-gdrive-user-limited";

const SCOPE = { folderID: "FROOT" };

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFake("fake-gdrive.yaml", 18092);
});

afterAll(() => fake?.stop());

const driver = () => new GDriveDriver({ apiOrigin: fake.origin });

describe("listing", () => {
  it("reaches files in a SUBFOLDER, not just direct children", async () => {
    // `'<id>' in parents` is one level and a corpus is recursive. A nested
    // file was readable by fetch and could never be indexed.
    const page = await driver().list(SCOPE, { service: SERVICE }, undefined);

    expect(page.resources.map((r) => r.id)).toContain("nested1");
  });

  it("indexes a shortcut to a document", async () => {
    const page = await driver().list(SCOPE, { service: SERVICE }, undefined);

    expect(page.resources.map((r) => r.id)).toContain("short1");
  });

  it("keeps the SHORTCUT's id, because that is what lives in the folder", async () => {
    // Its target sits outside the corpus; indexing the target's id would hand
    // the scope check a file it would rightly refuse.
    const page = await driver().list(SCOPE, { service: SERVICE }, undefined);

    expect(page.resources.map((r) => r.id)).not.toContain("target1");
  });

  it("takes the TARGET's version, so an edit is noticed", async () => {
    // A shortcut's own version never moves when the document it points at
    // changes, and a reconcile compares versions — so a corpus keyed on it
    // goes stale with nothing to notice.
    const page = await driver().list(SCOPE, { service: SERVICE }, undefined);

    const shortcut = page.resources.find((r) => r.id === "short1")!;
    expect(shortcut.version).toBe("9");
  });

  it("does not index a shortcut to something unindexable", async () => {
    // Following a shortcut must not mean indexing whatever is on the far end.
    const page = await driver().list(SCOPE, { service: SERVICE }, undefined);

    expect(page.resources.map((r) => r.id)).not.toContain("short2");
  });

  it("leaves another folder's files alone", async () => {
    const page = await driver().list(SCOPE, { service: SERVICE }, undefined);

    expect(page.resources.map((r) => r.id)).not.toContain("other1");
  });
});

describe("fetching", () => {
  it("exports a Google-native document", async () => {
    const doc = await driver().fetch(SCOPE, { service: SERVICE }, "doc1");

    expect(doc.markdown).toContain("release branch");
  });

  it("extracts text from a PDF", async () => {
    // The one path with a parser behind it, and silently dropped before it
    // existed. A real PDF, so this tests extraction rather than a stub.
    const doc = await driver().fetch(SCOPE, { service: SERVICE }, "pdf1");

    expect(doc.markdown).toContain("Statement of Work");
    // The phrase alone proves nothing: a PDF's content stream holds it in
    // plain view, so a RAW download contains it too and this passed with
    // extraction disabled. Mutation testing found that. The structure is what
    // only a parser removes.
    expect(doc.markdown).not.toContain("%PDF");
    expect(doc.markdown).not.toContain("endstream");
    expect(doc.markdown).not.toContain("/MediaBox");
  });

  it("reads a shortcut's TARGET, not the shortcut", async () => {
    const doc = await driver().fetch(SCOPE, { service: SERVICE }, "short1");

    expect(doc.markdown).toContain("Notes from the weekly sync");
  });

  it("refuses a file outside the corpus's folder", async () => {
    // Enforced by walking the parent chain, since the query cannot express it.
    await expect(driver().fetch(SCOPE, { service: SERVICE }, "other1")).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});

describe("the probe, with two identities", () => {
  it("allows a file this caller can open", async () => {
    const result = await driver().probe(SCOPE, { delegated: USER_LIMITED }, "doc1");

    expect(result.allowed).toBe(true);
  });

  it("refuses a file this caller cannot, though the corpus indexed it", async () => {
    await expect(driver().probe(SCOPE, { delegated: USER_LIMITED }, "secret1")).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("allows that same file for a caller who can", async () => {
    // Without this the refusal above passes equally when the file is simply
    // broken, which is not the property being claimed.
    const result = await driver().probe(SCOPE, { delegated: USER_FULL }, "secret1");

    expect(result.allowed).toBe(true);
  });

  it("refuses the service credential outright", async () => {
    await expect(driver().probe(SCOPE, { service: SERVICE }, "doc1")).rejects.toThrow(
      /delegated token/,
    );
  });
});

describe("live lookup", () => {
  it("is bounded to the corpus's folder", async () => {
    // "Deploys" appears in another client's folder too, so a bound that did
    // nothing would return it.
    const hits = await driver().searchAsUser({ delegated: USER_FULL }, SCOPE, "deploys");

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.id)).not.toContain("other1");
  });

  it("reaches a nested file, which the query alone cannot express", async () => {
    const hits = await driver().searchAsUser({ delegated: USER_FULL }, SCOPE, "nested");

    expect(hits.map((h) => h.id)).toContain("nested1");
  });

  it("is bounded by the caller as well as the folder", async () => {
    const full = await driver().searchAsUser({ delegated: USER_FULL }, SCOPE, "rates");
    const limited = await driver().searchAsUser({ delegated: USER_LIMITED }, SCOPE, "rates");

    expect(full.map((h) => h.id)).toContain("secret1");
    expect(limited.map((h) => h.id)).not.toContain("secret1");
  });
});

describe("the user read face", () => {
  it("reads OUTSIDE the corpus scope, bounded only by identity", async () => {
    // Deliberate: a citation leads out of the indexed folder, and the
    // caller's own token is what bounds this (docs/adr/0040).
    const doc = await driver().readAsUser({ delegated: USER_LIMITED }, "other1");

    expect(doc.markdown).toContain("somebody else");
  });

  it("still refuses a file the caller cannot open", async () => {
    await expect(driver().readAsUser({ delegated: USER_LIMITED }, "secret1")).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});
