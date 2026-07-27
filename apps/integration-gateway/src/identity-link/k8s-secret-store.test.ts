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
