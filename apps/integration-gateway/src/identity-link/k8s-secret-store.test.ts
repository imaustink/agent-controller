import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeApiError, FakeSecretApi, FakeWatch } from "../credential-store/__fixtures__/fake-secret-api.js";
import { K8sSecretIdentityLinkStore } from "./k8s-secret-store.js";

/**
 * Covers the Kubernetes-Secret-backed identity-link store (docs/adr/0034). The
 * predecessor of this suite tested a Redis implementation against a fake client;
 * the assertions that mattered -- round-trip encryption, no plaintext at rest, a
 * wait that actually resolves -- carry over unchanged, because the interface did.
 */

const KEY = randomBytes(32);
const NS = "controller-agent";

let api: FakeSecretApi;
let watch: FakeWatch;

function makeStore(): K8sSecretIdentityLinkStore {
  return new K8sSecretIdentityLinkStore(KEY, { namespace: NS, api, watch, pollIntervalMs: 20 });
}

beforeEach(() => {
  api = new FakeSecretApi();
  watch = new FakeWatch();
});

describe("K8sSecretIdentityLinkStore", () => {
  it("round-trips a credential through encrypt/decrypt", async () => {
    const store = makeStore();
    const cred = {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: "ghr_alsosecret",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };
    await store.set("github", "user-123", cred);
    expect(await store.get("github", "user-123")).toEqual(cred);
  });

  it("returns undefined for an unknown subject", async () => {
    expect(await makeStore().get("github", "nobody")).toBeUndefined();
  });

  it("never stores the plaintext token", async () => {
    const store = makeStore();
    await store.set("github", "user-456", {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: "ghr_alsosecret",
      refreshExpiresAt: undefined,
    });
    const raw = api.rawFor(api.onlyName());
    expect(raw).not.toContain("gho_supersecret");
    expect(raw).not.toContain("ghr_alsosecret");
  });

  // The login is what ADR 0031's principal resolution reads to converge the chat
  // and triage flows on one credential, and it must be readable WITHOUT the
  // encryption key -- both so `kubectl get secret -o yaml` is diagnosable and
  // because it is not secret in the first place.
  it("leaves the non-secret fields in plaintext", async () => {
    const store = makeStore();
    await store.set("github", "user-456", {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: undefined,
      refreshExpiresAt: undefined,
    });
    const raw = api.rawFor(api.onlyName());
    expect(Buffer.from(JSON.parse(raw).githubLogin, "base64").toString("utf8")).toBe("octocat");
  });

  it("throws at construction on a malformed encryption key", () => {
    expect(() => new K8sSecretIdentityLinkStore(Buffer.from("not32bytes"), { namespace: NS, api })).toThrow(
      /32 bytes/,
    );
  });

  it("handles a credential with no refresh token", async () => {
    const store = makeStore();
    const cred = {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: undefined,
      refreshExpiresAt: undefined,
    };
    await store.set("github", "user-789", cred);
    expect(await store.get("github", "user-789")).toEqual(cred);
  });

  it("replaces a credential in place when the same subject re-links", async () => {
    const store = makeStore();
    const base = { githubLogin: "octocat", expiresAt: "2026-07-20T12:00:00.000Z", refreshExpiresAt: undefined };
    await store.set("github", "user-1", { ...base, token: "gho_first", refreshToken: undefined });
    await store.set("github", "user-1", { ...base, token: "gho_second", refreshToken: undefined });
    expect((await store.get("github", "user-1"))?.token).toBe("gho_second");
    expect(api.secrets.size).toBe(1);
  });

  it("keeps different providers' records apart", async () => {
    const store = makeStore();
    const cred = {
      githubLogin: "octocat",
      token: "gho_supersecret",
      expiresAt: "2026-07-20T12:00:00.000Z",
      refreshToken: undefined,
      refreshExpiresAt: undefined,
    };
    await store.set("github", "user-1", cred);
    expect(await store.get("gitlab", "user-1")).toBeUndefined();
  });

  // A read that FAILED is not an answer of "never linked". Reporting it as one
  // is what puts a spurious one-time-setup prompt in front of someone who linked
  // months ago, so the store logs and returns a miss rather than throwing -- but
  // the layer beneath distinguishes them (see secret-record-store.test.ts).
  it("degrades to a miss rather than throwing when the API server fails", async () => {
    const store = makeStore();
    api.failWith = { verb: "read", error: new FakeApiError(500, "internal error") };
    await expect(store.get("github", "user-1")).resolves.toBeUndefined();
  });

  const CRED_TO_WRITE = {
    githubLogin: "octocat",
    token: "gho_supersecret",
    expiresAt: "2026-07-20T12:00:00.000Z",
    refreshToken: undefined,
    refreshExpiresAt: undefined,
  };

  // The regression this whole change exists for. A WRITE that fails is the
  // opposite of a read that fails: `set` is only ever called from a completed
  // OAuth flow that has already burned a one-time device/authcode code, so a
  // dropped write is a permanently lost link. Swallowing it (the old behavior)
  // let the linker report the flow "complete" while nothing persisted, so the
  // caller re-prompted on the very next turn forever, with no error anywhere --
  // the silent re-link loop. It must SURFACE, so this proves `set` rejects
  // rather than resolving. (The read path, above, must do the opposite; the two
  // tests together pin that asymmetry in place.)
  it("surfaces a write failure instead of silently dropping the completed link", async () => {
    const store = makeStore();
    api.failWith = { verb: "create", error: new FakeApiError(500, "etcdserver: request timed out") };
    await expect(store.set("github", "user-1", CRED_TO_WRITE)).rejects.toThrow(/timed out/);
    // And nothing half-written was left behind pretending to be a link.
    expect(await store.get("github", "user-1")).toBeUndefined();
  });

  // Durability is not "the API accepted the write" -- it is "the record is
  // readable afterward". A mutating webhook, an over-quota namespace, or a
  // lying backend can accept a create and leave nothing behind, which at the
  // `put` call alone is indistinguishable from success. The read-back is what
  // closes that gap: an accepted-but-empty write must throw, not resolve, or it
  // becomes the same silent loop by another route.
  it("rejects when the write is accepted but is not actually durable", async () => {
    // An API that acknowledges every create but stores nothing.
    const lyingApi = new FakeSecretApi();
    lyingApi.createNamespacedSecret = async (request) => {
      const name = (request.body as { metadata: { name: string } }).metadata.name;
      return { metadata: { name }, data: {} };
    };
    const store = new K8sSecretIdentityLinkStore(KEY, { namespace: NS, api: lyingApi });
    await expect(store.set("github", "user-1", CRED_TO_WRITE)).rejects.toThrow(/did not persist/);
  });

  // The headline ADR 0034 property, asserted at the store level: a completed
  // link outlives the process that wrote it. A brand-new store instance over
  // the same backing Secrets -- what a pod restart actually produces -- reads
  // the credential straight back, so the caller is never re-prompted for a link
  // it already has. (The Redis predecessor failed exactly here.)
  it("persists a completed link across a store restart", async () => {
    await makeStore().set("github", "user-1", CRED_TO_WRITE);
    // A fresh instance shares only the durable backing store, not in-process state.
    const afterRestart = new K8sSecretIdentityLinkStore(KEY, { namespace: NS, api, watch });
    expect(await afterRestart.get("github", "user-1")).toEqual(CRED_TO_WRITE);
  });
});

describe("K8sSecretIdentityLinkStore.waitForCompletion", () => {
  const CRED = {
    githubLogin: "octocat",
    token: "gho_supersecret",
    expiresAt: "2026-07-20T12:00:00.000Z",
    refreshToken: undefined,
    refreshExpiresAt: undefined,
  };

  it("resolves immediately when a credential is already stored", async () => {
    const store = makeStore();
    await store.set("github", "user-1", CRED);
    await expect(store.waitForCompletion("github", "user-1", 1_000)).resolves.toEqual(CRED);
  });

  it("resolves undefined once timeoutMs elapses with no completion", async () => {
    await expect(makeStore().waitForCompletion("github", "nobody", 5)).resolves.toBeUndefined();
  });

  // The auto-continue promise the link prompt makes ("I'll continue
  // automatically once you finish"). Its Redis predecessor silently broke once
  // and collapsed every wait into an instant false timeout, so this asserts both
  // that the credential arrives and that it arrives promptly.
  it("resolves once a concurrent set() lands, well within the timeout", async () => {
    const store = makeStore();
    const started = Date.now();
    const waiting = store.waitForCompletion("github", "user-2", 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.set("github", "user-2", CRED);
    watch.emit("ADDED");
    await expect(waiting).resolves.toEqual(CRED);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
