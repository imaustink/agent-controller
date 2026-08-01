import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeApiError, FakeSecretApi, FakeWatch } from "../credential-store/__fixtures__/fake-secret-api.js";
import { K8sSecretClaudeTokenStore } from "./k8s-secret-store.js";

/**
 * Covers the Kubernetes-Secret-backed Claude credential store
 * (docs/adr/0034). Ported from the Redis implementation's suite: every
 * behavioural assertion carries over, because the interface did. What changed is
 * where "at rest" is, which the plaintext assertions now check by inspecting the
 * written Secret rather than a mock keyspace.
 */

const KEY = randomBytes(32);
const NS = "controller-agent";

let api: FakeSecretApi;
let watch: FakeWatch;

function makeStore(): K8sSecretClaudeTokenStore {
  return new K8sSecretClaudeTokenStore(KEY, { namespace: NS, api, watch, pollIntervalMs: 20 });
}

/** Every stored record body, so a plaintext assertion can't miss the one it should have checked. */
function allRaw(): string {
  return JSON.stringify([...api.secrets.values()]);
}

beforeEach(() => {
  api = new FakeSecretApi();
  watch = new FakeWatch();
});

describe("K8sSecretClaudeTokenStore", () => {
  it("round-trips a setup-token record through encrypt/decrypt", async () => {
    const store = makeStore();
    const record = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-123", record);
    expect(await store.get("user-123")).toEqual(record);
  });

  it("round-trips a login record through encrypt/decrypt", async () => {
    const store = makeStore();
    const record = { kind: "login" as const, credentialsJson: '{"accessToken":"supersecret"}', createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-login-1", record);
    expect(await store.get("user-login-1", "login")).toEqual(record);
  });

  it("keeps a setup-token record and a login record for the same subject independent", async () => {
    const store = makeStore();
    const setupRecord = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
    const loginRecord = { kind: "login" as const, credentialsJson: '{"accessToken":"other"}', createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-both", setupRecord);
    await store.set("user-both", loginRecord);
    expect(await store.get("user-both")).toEqual(setupRecord);
    expect(await store.get("user-both", "login")).toEqual(loginRecord);
    // Distinct objects, which is what makes neither `set` nor `delete` able to
    // clobber the other kind.
    expect(api.secrets.size).toBe(2);
  });

  it("returns undefined for an unknown subject", async () => {
    expect(await makeStore().get("nobody")).toBeUndefined();
  });

  it("returns undefined for an unknown subject's login kind", async () => {
    expect(await makeStore().get("nobody", "login")).toBeUndefined();
  });

  it("never stores the plaintext token", async () => {
    const store = makeStore();
    await store.set("user-456", { kind: "setup-token", token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" });
    expect(allRaw()).not.toContain("sk-ant-oat01-supersecret");
  });

  it("never stores the plaintext credentialsJson, and only under the login name", async () => {
    const store = makeStore();
    await store.set("user-login-2", { kind: "login", credentialsJson: '{"accessToken":"supersecret"}', createdAt: "2026-07-22T00:00:00.000Z" });
    expect(allRaw()).not.toContain("supersecret");
    expect(api.onlyName()).toMatch(/^claude-auth-login-/);
  });

  it("throws at construction on a malformed encryption key", () => {
    expect(() => new K8sSecretClaudeTokenStore(Buffer.from("not32bytes"), { namespace: NS, api })).toThrow(/32 bytes/);
  });

  it("removes a subject's stored token on delete", async () => {
    const store = makeStore();
    await store.set("user-789", { kind: "setup-token", token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" });
    await store.delete("user-789");
    expect(await store.get("user-789")).toBeUndefined();
  });

  it("removes a subject's stored login record on delete without touching its setup-token record", async () => {
    const store = makeStore();
    const setupRecord = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("user-999", setupRecord);
    await store.set("user-999", { kind: "login", credentialsJson: '{"accessToken":"x"}', createdAt: "2026-07-22T00:00:00.000Z" });
    await store.delete("user-999", "login");
    expect(await store.get("user-999", "login")).toBeUndefined();
    expect(await store.get("user-999")).toEqual(setupRecord);
  });

  it("moves an authorized credential to a new subject, leaving nothing behind", async () => {
    // ADR 0031: the orchestrator re-keyed these records onto the caller's
    // principal. Moving the existing one is what spares every current user a
    // login for a credential the gateway is already holding.
    const store = makeStore();
    const record = { kind: "login" as const, credentialsJson: '{"accessToken":"supersecret"}', createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("openwebui:42", record);

    expect(await store.rekey("openwebui:42", "github:alice", "login")).toBe("moved");

    expect(await store.get("github:alice", "login")).toEqual(record);
    // Moved, not copied: the write-back that keeps a login credential alive
    // only ever writes the new key, so a leftover copy would rot and then fail
    // whichever flow still read it.
    expect(await store.get("openwebui:42", "login")).toBeUndefined();
  });

  it("moves only the requested kind", async () => {
    const store = makeStore();
    const setupRecord = { kind: "setup-token" as const, token: "sk-ant-oat01-x", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("openwebui:42", setupRecord);
    await store.set("openwebui:42", { kind: "login", credentialsJson: "{}", createdAt: "2026-07-22T00:00:00.000Z" });

    await store.rekey("openwebui:42", "github:alice", "login");

    expect(await store.get("openwebui:42")).toEqual(setupRecord);
    expect(await store.get("github:alice")).toBeUndefined();
  });

  it("refuses to overwrite a record already at the destination", async () => {
    // The destination's record is by definition at least as current as the one
    // being moved -- clobbering it would replace a live credential with an older
    // one and cause the "Login expired" failure this is meant to prevent.
    const store = makeStore();
    const current = { kind: "setup-token" as const, token: "sk-ant-oat01-current", createdAt: "2026-07-25T00:00:00.000Z" };
    const stale = { kind: "setup-token" as const, token: "sk-ant-oat01-stale", createdAt: "2026-07-01T00:00:00.000Z" };
    await store.set("github:alice", current);
    await store.set("openwebui:42", stale);

    expect(await store.rekey("openwebui:42", "github:alice")).toBe("occupied");

    expect(await store.get("github:alice")).toEqual(current);
    // The source is left intact too: nothing was moved, so nothing is deleted.
    expect(await store.get("openwebui:42")).toEqual(stale);
  });

  it("reports not-found rather than creating an empty record", async () => {
    const store = makeStore();
    expect(await store.rekey("openwebui:nobody", "github:alice")).toBe("not-found");
    expect(await store.get("github:alice")).toBeUndefined();
  });

  it("treats a self-move as a no-op instead of deleting the record", async () => {
    // Guards the degenerate case where a caller's principal IS its subject: the
    // naive move (set then delete) would delete what it just wrote.
    const store = makeStore();
    const record = { kind: "setup-token" as const, token: "sk-ant-oat01-x", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("github:alice", record);

    expect(await store.rekey("github:alice", "github:alice")).toBe("occupied");
    expect(await store.get("github:alice")).toEqual(record);
  });

  // The ordering `rekey` is careful about: `set` swallows its own errors, so a
  // move that deleted the source without confirming the destination could drop
  // the human's only credential -- strictly worse than the extra login it exists
  // to avoid.
  it("keeps the source intact when the destination write fails", async () => {
    const store = makeStore();
    const record = { kind: "setup-token" as const, token: "sk-ant-oat01-x", createdAt: "2026-07-22T00:00:00.000Z" };
    await store.set("openwebui:42", record);
    api.failWith = { verb: "create", error: new FakeApiError(500, "internal error") };

    expect(await store.rekey("openwebui:42", "github:alice")).toBe("not-found");
    expect(await store.get("openwebui:42")).toEqual(record);
  });

  it("degrades to a miss rather than throwing when the API server fails", async () => {
    const store = makeStore();
    api.failWith = { verb: "read", error: new FakeApiError(500, "internal error") };
    await expect(store.get("user-1")).resolves.toBeUndefined();
  });
});

describe("K8sSecretClaudeTokenStore write-back grants", () => {
  it("round-trips a credential write-back grant back to its subject", async () => {
    const store = makeStore();
    const { token } = await store.createWritebackToken("user-wb", 900);
    expect(await store.resolveWritebackToken(token)).toBe("user-wb");
  });

  it("never stores a write-back grant in a replayable form", async () => {
    const store = makeStore();
    const { token } = await store.createWritebackToken("user-wb", 900);
    // The grant is a bearer credential: anything able to read the namespace must
    // not come away with a usable one, so only its hash is stored.
    expect([...api.secrets.keys()].some((k) => k.includes(token))).toBe(false);
    expect(allRaw()).not.toContain(token);
  });

  it("returns the backing object's name so the caller can hand it an owner", async () => {
    // How a grant gets cleaned up: agent-orchestrator's launcher patches the
    // AgentRun ownerReference onto this object, and the controller's existing
    // retention sweep reclaims it with the run (docs/adr/0034).
    const store = makeStore();
    const { secretName } = await store.createWritebackToken("user-wb", 900);
    expect(secretName).toMatch(/^claude-writeback-grant-[0-9a-f]{16}$/);
    expect([...api.secrets.values()].map((s) => s.metadata.name)).toContain(secretName);
  });

  it("stops authorizing once the grant's window has passed", async () => {
    // Kubernetes has no TTL on a Secret, so expiry has to be enforced on read:
    // an object that outlives its window (its owning AgentRun not yet swept, or
    // never created because the launch failed) must not still work.
    const store = makeStore();
    const { token } = await store.createWritebackToken("user-wb", -1);
    expect(await store.resolveWritebackToken(token)).toBeUndefined();
  });

  it("treats an unknown or empty grant as invalid", async () => {
    const store = makeStore();
    expect(await store.resolveWritebackToken("never-minted")).toBeUndefined();
    expect(await store.resolveWritebackToken("")).toBeUndefined();
  });

  it("mints distinct grants per call, so revoking one can't affect another", async () => {
    const store = makeStore();
    const a = await store.createWritebackToken("user-wb", 900);
    const b = await store.createWritebackToken("user-wb", 900);
    expect(a.token).not.toBe(b.token);
    expect(a.secretName).not.toBe(b.secretName);
  });

  // Unlike `set`/`delete`, this one must NOT swallow: the caller injects the
  // returned token into an AgentRun, and a grant the API server never accepted
  // would look valid to the run and 401 on every write-back attempt.
  it("fails loudly when the grant cannot be persisted", async () => {
    const store = makeStore();
    api.failWith = { verb: "create", error: new FakeApiError(403, "forbidden") };
    await expect(store.createWritebackToken("user-wb", 900)).rejects.toThrow(/forbidden/);
  });
});

describe("K8sSecretClaudeTokenStore.waitForCompletion", () => {
  const RECORD = { kind: "setup-token" as const, token: "sk-ant-oat01-supersecret", createdAt: "2026-07-22T00:00:00.000Z" };
  const LOGIN_RECORD = { kind: "login" as const, credentialsJson: '{"accessToken":"supersecret"}', createdAt: "2026-07-22T00:00:00.000Z" };

  it("resolves immediately when a token is already stored", async () => {
    const store = makeStore();
    await store.set("user-1", RECORD);
    await expect(store.waitForCompletion("user-1", 1_000)).resolves.toEqual(RECORD);
  });

  it("resolves once a concurrent set() lands", async () => {
    const store = makeStore();
    const waiting = store.waitForCompletion("user-2", 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.set("user-2", RECORD);
    watch.emit("ADDED");
    await expect(waiting).resolves.toEqual(RECORD);
  });

  it("resolves undefined once timeoutMs elapses with no completion", async () => {
    await expect(makeStore().waitForCompletion("nobody", 5)).resolves.toBeUndefined();
  });

  it("resolves immediately for a login record when kind='login' is passed", async () => {
    const store = makeStore();
    await store.set("user-login-wait", LOGIN_RECORD);
    await expect(store.waitForCompletion("user-login-wait", 1_000, "login")).resolves.toEqual(LOGIN_RECORD);
  });

  it("resolves once a concurrent login set() lands", async () => {
    const store = makeStore();
    const waiting = store.waitForCompletion("user-login-wait-2", 60_000, "login");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.set("user-login-wait-2", LOGIN_RECORD);
    watch.emit("ADDED");
    await expect(waiting).resolves.toEqual(LOGIN_RECORD);
  });

  it("does not resolve a login waiter from a concurrent setup-token set() for the same subject", async () => {
    const store = makeStore();
    const waiting = store.waitForCompletion("user-mixed", 50, "login");
    await store.set("user-mixed", RECORD);
    watch.emit("ADDED");
    await expect(waiting).resolves.toBeUndefined();
  });
});
