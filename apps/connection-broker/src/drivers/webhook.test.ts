import { describe, expect, it } from "vitest";
import { ConfluenceDriver } from "./confluence.js";
import { SlackDriver } from "./slack.js";
import { PermissionDeniedError } from "./types.js";
import { hmacHex } from "./webhook-signature.js";

const SECRET = "shared-signing-secret";

describe("slack webhooks", () => {
  const driver = new SlackDriver();
  const scope = { channel: "C123ABC" };

  const signed = (body: string, at = Date.now()) => {
    const timestamp = String(Math.floor(at / 1000));
    return {
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${hmacHex(SECRET, `v0:${timestamp}:${body}`)}`,
      },
      rawBody: body,
    };
  };

  it("names the thread a new message belongs to", async () => {
    const body = JSON.stringify({ event: { channel: "C123ABC", ts: "2.2", thread_ts: "1.1" } });
    // The thread is the indexed unit, so a reply names its parent.
    expect(driver.parseWebhook!(signed(body), SECRET, scope)).toEqual({ sourceIds: ["1.1"] });
  });

  it("uses the message ts when it starts a thread", async () => {
    const body = JSON.stringify({ event: { channel: "C123ABC", ts: "1.1" } });
    expect(driver.parseWebhook!(signed(body), SECRET, scope)).toEqual({ sourceIds: ["1.1"] });
  });

  it("ignores an event for another channel", () => {
    // Verified, but irrelevant — and emphatically not a reason to sync.
    const body = JSON.stringify({ event: { channel: "COTHER", ts: "1.1" } });
    expect(driver.parseWebhook!(signed(body), SECRET, scope)).toBeUndefined();
  });

  it("ignores the url_verification handshake", () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    expect(driver.parseWebhook!(signed(body), SECRET, scope)).toBeUndefined();
  });

  it("refuses a forged signature", () => {
    const body = JSON.stringify({ event: { channel: "C123ABC", ts: "1.1" } });
    const request = signed(body);
    request.headers["x-slack-signature"] = "v0=deadbeef";

    // This endpoint takes no bearer token, so the signature is the whole
    // boundary between a stranger and spending a client's credential.
    expect(() => driver.parseWebhook!(request, SECRET, scope)).toThrow(PermissionDeniedError);
  });

  it("refuses a body altered after signing", () => {
    const request = signed(JSON.stringify({ event: { channel: "C123ABC", ts: "1.1" } }));
    request.rawBody = JSON.stringify({ event: { channel: "C123ABC", ts: "9.9" } });

    expect(() => driver.parseWebhook!(request, SECRET, scope)).toThrow(PermissionDeniedError);
  });

  it("refuses a replayed delivery", () => {
    const body = JSON.stringify({ event: { channel: "C123ABC", ts: "1.1" } });
    // Correctly signed, but from an hour ago. A signature alone does not stop
    // replay, and replaying a notification makes the broker spend a credential
    // on demand.
    const old = signed(body, Date.now() - 60 * 60 * 1000);

    expect(() => driver.parseWebhook!(old, SECRET, scope)).toThrow(/replay window/);
  });

  it("refuses an unsigned request", () => {
    expect(() =>
      driver.parseWebhook!({ headers: {}, rawBody: "{}" }, SECRET, scope),
    ).toThrow(PermissionDeniedError);
  });
});

describe("confluence webhooks", () => {
  const driver = new ConfluenceDriver({ siteBaseUrl: "https://x.atlassian.net/wiki", cloudId: "c" });
  const scope = { space: "SNC" };

  const signed = (body: string) => ({
    headers: { "x-hub-signature": `sha256=${hmacHex(SECRET, body)}` },
    rawBody: body,
  });

  it("names the changed page", () => {
    const body = JSON.stringify({ page: { id: 12345, spaceKey: "SNC" } });
    expect(driver.parseWebhook!(signed(body), SECRET, scope)).toEqual({ sourceIds: ["12345"] });
  });

  it("ignores a change in another space", () => {
    // The same boundary assertInScope enforces on the read path, applied before
    // a credential is spent rather than after.
    const body = JSON.stringify({ page: { id: 1, spaceKey: "OTHER" } });
    expect(driver.parseWebhook!(signed(body), SECRET, scope)).toBeUndefined();
  });

  it("reports an unknown change as an empty list, not as nothing", () => {
    // Which the caller escalates to a full pass: a deletion whose event never
    // arrived would otherwise never be noticed.
    const body = JSON.stringify({ space: { spaceKey: "SNC" } });
    expect(driver.parseWebhook!(signed(body), SECRET, scope)).toEqual({ sourceIds: [] });
  });

  it("refuses a forged signature", () => {
    const request = signed(JSON.stringify({ page: { id: 1, spaceKey: "SNC" } }));
    request.headers["x-hub-signature"] = "sha256=0000";
    expect(() => driver.parseWebhook!(request, SECRET, scope)).toThrow(PermissionDeniedError);
  });

  it("refuses an unsigned request", () => {
    expect(() => driver.parseWebhook!({ headers: {}, rawBody: "{}" }, SECRET, scope)).toThrow(
      PermissionDeniedError,
    );
  });
});
