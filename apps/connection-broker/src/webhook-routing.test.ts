import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createBrokerServer } from "./server.js";
import { StaticCorpusRegistry } from "./registry.js";
import { PermissionDeniedError, type Driver, type ProbeGranularity } from "./drivers/types.js";

/**
 * A provider signs and delivers per INTEGRATION — one Slack app, one Confluence
 * site — so a delivery has to reach however many Corpora cover what changed
 * (ADR 0043 §4). The driver reports which subset it is about; the routing
 * tested here is the broker's.
 */
function fakeDriver(parseWebhook?: Driver["parseWebhook"]): Driver {
  return {
    provider: "slack",
    validateScope: () => {},
    list: vi.fn(),
    fetch: vi.fn(),
    probeGranularity: (): ProbeGranularity => "connection",
    probe: vi.fn(),
    parseWebhook,
  };
}

describe("webhook fan-out", () => {
  let server: Server | undefined;

  afterEach(() => server?.close());

  /** Two Corpora over ONE Connection, plus a third over a different one. */
  function start(parseWebhook?: Driver["parseWebhook"]) {
    const onChange = vi.fn();
    const driver = fakeDriver(parseWebhook);
    server = createBrokerServer({
      auth: { orchestratorToken: "orch", syncTokens: new Map() },
      registry: new StaticCorpusRegistry([
        { name: "eng", connection: "bitovi-slack", driver, scope: { channel: "C_ENG" }, allowedRoles: [], serviceToken: "s" },
        { name: "eng-mirror", connection: "bitovi-slack", driver, scope: { channel: "C_ENG" }, allowedRoles: [], serviceToken: "s" },
        { name: "general", connection: "bitovi-slack", driver, scope: { channel: "C_GEN" }, allowedRoles: [], serviceToken: "s" },
        { name: "elsewhere", connection: "other-slack", driver, scope: { channel: "C_ENG" }, allowedRoles: [], serviceToken: "s" },
      ]),
      webhooks: { secretFor: () => "signing-secret", onChange },
    });
    server.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, onChange };
  }

  const deliver = (base: string, connection = "bitovi-slack") =>
    fetch(`${base}/connections/${connection}/webhook`, { method: "POST", body: "{}" });

  it("routes a delivery to every Corpus covering the reported subset", async () => {
    const { base, onChange } = start(() => ({ scopeKey: "C_ENG", sourceIds: ["1.1"] }));

    const response = await deliver(base);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ acted: true, corpora: 2 });
    // Both Corpora over this channel, and neither of the others: two Corpora
    // may legitimately overlap, and both need the update.
    expect(onChange.mock.calls.map(([corpus]) => corpus).sort()).toEqual(["eng", "eng-mirror"]);
  });

  it("does not cross Connections, even for the same channel id", async () => {
    // `elsewhere` is scoped to C_ENG too, but over a different Slack app. A
    // delivery signed by one workspace must not touch another's material.
    const { base, onChange } = start(() => ({ scopeKey: "C_ENG", sourceIds: ["1.1"] }));

    await deliver(base);

    expect(onChange.mock.calls.map(([corpus]) => corpus)).not.toContain("elsewhere");
  });

  it("accepts a delivery about a subset nobody indexed", async () => {
    // The ORDINARY case: most events in a workspace concern channels no Corpus
    // covers. Answered 200 because providers disable endpoints that keep
    // returning errors.
    const { base, onChange } = start(() => ({ scopeKey: "C_NOBODY", sourceIds: ["1.1"] }));

    const response = await deliver(base);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ acted: false });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("escalates a delivery with no scope key to EVERY Corpus on the Connection", async () => {
    // "Something changed, we do not know where." Doing nothing would let a
    // deletion whose event never named a subset go unnoticed forever.
    const { base, onChange } = start(() => ({ sourceIds: [] }));

    await deliver(base);

    expect(onChange.mock.calls.map(([corpus]) => corpus).sort()).toEqual([
      "eng",
      "eng-mirror",
      "general",
    ]);
    // An empty id list is what makes the scheduler run a FULL pass.
    expect(onChange.mock.calls.every(([, ids]) => (ids as string[]).length === 0)).toBe(true);
  });

  it("rejects a delivery whose signature does not verify", async () => {
    const { base, onChange } = start(() => {
      throw new PermissionDeniedError("signature did not verify");
    });

    // This endpoint takes no bearer token, so the signature is the whole
    // boundary between a stranger and spending a client's credential.
    expect((await deliver(base)).status).toBe(401);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts a verified delivery the driver says is not actionable", async () => {
    // A Slack URL-verification handshake, say.
    const { base, onChange } = start(() => undefined);

    expect((await deliver(base)).status).toBe(200);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("answers the same for an unknown connection as for one it cannot serve", async () => {
    // A distinguishable response would let an unauthenticated caller enumerate
    // which connections exist.
    const { base } = start(() => ({ scopeKey: "C_ENG", sourceIds: [] }));

    expect((await deliver(base, "never-heard-of-it")).status).toBe(404);
  });

  it("is not reachable when the driver cannot parse webhooks", async () => {
    const { base } = start(undefined);
    expect((await deliver(base)).status).toBe(404);
  });
});
