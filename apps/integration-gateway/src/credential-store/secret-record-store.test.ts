import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeApiError, FakeSecretApi, FakeWatch } from "./__fixtures__/fake-secret-api.js";
import { decodeEncryptionKey } from "./field-encryption.js";
import { isConflictError, isNotFoundError, RECORD_KEY_FIELD, SecretRecordStore } from "./secret-record-store.js";

const NS = "controller-agent";

function makeStore(api = new FakeSecretApi(), watch?: FakeWatch): SecretRecordStore {
  return new SecretRecordStore({
    namespace: NS,
    namePrefix: "identity-link-github",
    keyLabel: "controller-agent.io/subject",
    commonLabels: { "controller-agent.io/credential": "identity-link" },
    api,
    ...(watch ? { watch } : {}),
    // Production polls every 5s, which outlives the default test timeout. The
    // interval's VALUE is not what these tests are about -- that it converges at
    // all without a watch event is.
    pollIntervalMs: 20,
  });
}

describe("decodeEncryptionKey", () => {
  const KEY = randomBytes(32);

  it("decodes a 32-byte base64 key", () => {
    expect(decodeEncryptionKey(KEY.toString("base64"))).toEqual(KEY);
  });

  it("decodes a 32-byte hex key", () => {
    expect(decodeEncryptionKey(KEY.toString("hex"))).toEqual(KEY);
  });

  it("throws on a malformed/wrong-length key", () => {
    expect(() => decodeEncryptionKey("too-short")).toThrow(/32 bytes/);
  });
});

describe("SecretRecordStore naming", () => {
  it("turns a key that is not a legal object name into one", () => {
    // The bug this prevents: `openwebui:1234` and a 300-character IdP `sub` are
    // both real record keys and neither is a legal Secret name, so an unhashed
    // name would 422 on every write for exactly the users this store exists for.
    const name = makeStore().nameFor("openwebui:1234");
    expect(name).toMatch(/^identity-link-github-[0-9a-f]{16}$/);
    expect(name.length).toBeLessThanOrEqual(253);
  });

  it("gives a long key a legal name too", () => {
    const name = makeStore().nameFor(`oidc:${"x".repeat(400)}`);
    expect(name).toMatch(/^identity-link-github-[0-9a-f]{16}$/);
  });

  it("is stable for the same key and distinct for different keys", () => {
    const store = makeStore();
    expect(store.nameFor("github:imaustink")).toBe(store.nameFor("github:imaustink"));
    expect(store.nameFor("github:imaustink")).not.toBe(store.nameFor("openwebui:1234"));
  });
});

describe("SecretRecordStore", () => {
  it("round-trips a record's fields", async () => {
    const store = makeStore();
    await store.put("github:imaustink", { token: "abc", expiresAt: "2026-07-20T12:00:00.000Z" });
    expect(await store.get("github:imaustink")).toEqual({ token: "abc", expiresAt: "2026-07-20T12:00:00.000Z" });
  });

  it("returns undefined for an unknown key", async () => {
    expect(await makeStore().get("nobody")).toBeUndefined();
  });

  it("updates an existing record via replace rather than a second create", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    await store.put("k", { token: "first" });
    await store.put("k", { token: "second" });
    expect(await store.get("k")).toEqual({ token: "second" });
    // Create is ATTEMPTED on both writes -- the second one 409s and is retried as
    // a replace. That extra attempt is the deliberate cost of not needing a
    // read-before-write, and asserting it here keeps a future "optimization"
    // from silently turning an update into a create that fails.
    expect(api.calls.filter((c) => c.startsWith("create"))).toHaveLength(2);
    expect(api.calls.filter((c) => c.startsWith("replace"))).toHaveLength(1);
  });

  it("mirrors the plaintext key onto a label, sanitized for Kubernetes", async () => {
    const api = new FakeSecretApi();
    await makeStore(api).put("openwebui:1234", { token: "abc" });
    const stored = [...api.secrets.values()][0]!;
    expect(stored.metadata.labels?.["controller-agent.io/subject"]).toBe("openwebui-1234");
    expect(stored.metadata.labels?.["controller-agent.io/credential"]).toBe("identity-link");
  });

  // The label is lossy (charset-sanitized, truncated at 63 chars) and the object
  // name is a hash, so without this a credential filed under an unexpected
  // subject could be seen to exist but not attributed -- which is precisely the
  // class of bug ADR 0029/0031 are about.
  it("records the exact plaintext key losslessly, and keeps it out of the record", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    await store.put("openwebui:1234", { token: "abc" });
    const stored = [...api.secrets.values()][0]!;
    expect(Buffer.from(stored.data[RECORD_KEY_FIELD]!, "base64").toString("utf8")).toBe("openwebui:1234");
    // The stores read named fields; the bookkeeping field is not one of theirs.
    expect(await store.get("openwebui:1234")).toEqual({ token: "abc" });
  });

  it("treats a deleted record as absent, and deleting a missing one as success", async () => {
    const store = makeStore();
    await store.put("k", { token: "abc" });
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
    await expect(store.delete("k")).resolves.toBeUndefined();
  });

  // The distinction this asserts is the whole reason `isNotFoundError` exists:
  // a store that swallowed every read failure as a miss would make an API-server
  // blip indistinguishable from "this user never linked", and ADR 0031's
  // pre-flight acts on that answer by prompting for a link someone already
  // completed.
  it("propagates a non-404 read failure instead of reporting an empty store", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    api.failWith = { verb: "read", error: new FakeApiError(403, "forbidden") };
    await expect(store.get("k")).rejects.toThrow(/forbidden/);
  });

  it("propagates a non-409 write failure instead of retrying it as a replace", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    api.failWith = { verb: "create", error: new FakeApiError(403, "forbidden") };
    await expect(store.put("k", { token: "abc" })).rejects.toThrow(/forbidden/);
    expect(api.calls.filter((c) => c.startsWith("replace"))).toHaveLength(0);
  });

  it("reports an existing but empty record as absent rather than a half-credential", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    await api.createNamespacedSecret({
      namespace: NS,
      body: { metadata: { name: store.nameFor("k") }, stringData: {} },
    });
    expect(await store.get("k")).toBeUndefined();
  });
});

describe("SecretRecordStore.waitForRecord", () => {
  it("resolves immediately when the record already exists", async () => {
    const store = makeStore();
    await store.put("k", { token: "abc" });
    await expect(store.waitForRecord("k", 1_000)).resolves.toEqual({ token: "abc" });
  });

  it("resolves undefined once timeoutMs elapses with nothing stored", async () => {
    await expect(makeStore().waitForRecord("nobody", 5)).resolves.toBeUndefined();
  });

  // The behaviour a pending identity link depends on: the user finishes in their
  // browser, the write lands, and the turn that was waiting continues -- rather
  // than sitting out the full flow expiry and telling them to send another
  // message. The Redis version got this wrong once already (an unconnected
  // subscriber collapsed every wait into an instant false timeout), so this
  // asserts both that it resolves and that it resolves promptly.
  it("resolves promptly when a watch event fires well within the timeout", async () => {
    const api = new FakeSecretApi();
    const watch = new FakeWatch();
    const store = makeStore(api, watch);
    const started = Date.now();
    const waiting = store.waitForRecord("k", 60_000);
    // Let the watch establish before the record lands, which is the real
    // ordering: the link prompt is shown, then the human acts.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.put("k", { token: "abc" });
    watch.emit("ADDED");
    await expect(waiting).resolves.toEqual({ token: "abc" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still resolves without any watch at all, on the poll alone", async () => {
    const api = new FakeSecretApi();
    const watch = new FakeWatch();
    watch.failToStart = true;
    const store = makeStore(api, watch);
    const waiting = store.waitForRecord("k", 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.put("k", { token: "abc" });
    // No event is ever emitted; the re-check the watch attempt schedules and the
    // interval poll are what must find it.
    await expect(waiting).resolves.toEqual({ token: "abc" });
  });

  it("aborts its watch once it settles, rather than leaking the connection", async () => {
    const api = new FakeSecretApi();
    const watch = new FakeWatch();
    const store = makeStore(api, watch);
    const waiting = store.waitForRecord("k", 30);
    await expect(waiting).resolves.toBeUndefined();
    // Allow the watch's own promise to settle after the timeout won the race.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(watch.aborted).toBeGreaterThan(0);
  });
});

describe("API error classification", () => {
  it("recognises 404 across the shapes client-node has used", () => {
    expect(isNotFoundError(new FakeApiError(404, "nope"))).toBe(true);
    expect(isNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isNotFoundError({ response: { statusCode: 404 } })).toBe(true);
    expect(isNotFoundError(new Error('secrets "x" not found'))).toBe(true);
    expect(isNotFoundError(new FakeApiError(403, "forbidden"))).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });

  it("recognises 409 the same way", () => {
    expect(isConflictError(new FakeApiError(409, "nope"))).toBe(true);
    expect(isConflictError(new Error('secrets "x" already exists'))).toBe(true);
    expect(isConflictError(new FakeApiError(404, "not found"))).toBe(false);
  });
});

/**
 * The one label-selector scan in this store, and a deliberate exception to its
 * own "no listing" rule -- see `listRecords`' doc. A maintenance sweep has no
 * key to compute a Secret name from, so enumerating IS the task.
 */
describe("SecretRecordStore.listRecords", () => {
  it("returns every record of this type with its plaintext key, scoped by label selector", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    await store.put("github:alice", { token: "a" });
    await store.put("openwebui:1234", { token: "b" });

    // A record of a DIFFERENT type in the same namespace must not be returned.
    const other = new SecretRecordStore({
      namespace: NS,
      namePrefix: "claude-auth-login",
      keyLabel: "controller-agent.io/subject",
      commonLabels: { "controller-agent.io/credential": "claude-auth" },
      api,
    });
    await other.put("github:bob", { credentialsJson: "{}" });

    const records = await store.listRecords();

    expect(records.map((r) => r.key).sort()).toEqual(["github:alice", "openwebui:1234"]);
    // The bookkeeping field is stripped, exactly as `get` strips it.
    expect(records[0]?.fields[RECORD_KEY_FIELD]).toBeUndefined();
    expect(records.find((r) => r.key === "github:alice")?.fields.token).toBe("a");
    expect(api.calls).toContain("list:controller-agent.io/credential=identity-link");
  });

  // The object name is a one-way hash, so a record without its plaintext key
  // cannot be attributed to a subject -- and acting on an unattributable
  // credential is worse than leaving it alone.
  it("skips a record whose plaintext key was never stored, rather than guessing", async () => {
    const api = new FakeSecretApi();
    api.secrets.set(`${NS}/identity-link-github-deadbeefdeadbeef`, {
      metadata: { name: "identity-link-github-deadbeefdeadbeef", labels: { "controller-agent.io/credential": "identity-link" } },
      data: { token: Buffer.from("orphan", "utf8").toString("base64") },
    });

    expect(await makeStore(api).listRecords()).toEqual([]);
  });

  // A failed list is not an empty store; the sweeper's own handling depends on
  // this surfacing rather than resolving empty.
  it("propagates a listing failure instead of reporting an empty store", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    await store.put("github:alice", { token: "a" });
    api.failWith = { verb: "list", error: new FakeApiError(403, "forbidden") };

    await expect(store.listRecords()).rejects.toThrow(/forbidden/);
  });

  it("reports no records when the API has no list verb at all (an older double or client)", async () => {
    const api = new FakeSecretApi();
    const store = makeStore(api);
    await store.put("github:alice", { token: "a" });
    // Simulate a SecretApiLike without the optional verb.
    (api as { listNamespacedSecret?: unknown }).listNamespacedSecret = undefined;

    expect(await store.listRecords()).toEqual([]);
  });
});
