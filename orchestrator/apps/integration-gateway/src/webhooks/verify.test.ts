import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { slackUrlVerificationChallenge, verifyHeaderName, verifyWebhookRequest } from "./verify.js";

const SECRET = "shh";
const body = Buffer.from('{"hello":"world"}');
const hex = (data: Buffer | string): string => createHmac("sha256", SECRET).update(data).digest("hex");

describe("verifyWebhookRequest hmacSha256", () => {
  const verify = { scheme: "hmacSha256" as const, header: "X-Hub-Signature-256", prefix: "sha256=", secretRef: { name: "s", key: "k" } };

  it("accepts the right signature (header lookup is case-insensitive, hex case-insensitive)", () => {
    expect(verifyWebhookRequest(verify, SECRET, { "x-hub-signature-256": `sha256=${hex(body)}` }, body)).toEqual({ ok: true });
    expect(verifyWebhookRequest(verify, SECRET, { "x-hub-signature-256": `sha256=${hex(body).toUpperCase()}` }, body).ok).toBe(true);
  });

  it("rejects a wrong, missing, unprefixed or truncated signature", () => {
    expect(verifyWebhookRequest(verify, SECRET, { "x-hub-signature-256": `sha256=${hex("other")}` }, body).ok).toBe(false);
    expect(verifyWebhookRequest(verify, SECRET, {}, body).ok).toBe(false);
    expect(verifyWebhookRequest(verify, SECRET, { "x-hub-signature-256": hex(body) }, body).ok).toBe(false);
    expect(verifyWebhookRequest(verify, SECRET, { "x-hub-signature-256": `sha256=${hex(body).slice(0, 40)}` }, body).ok).toBe(false);
  });

  it("fails closed on a missing or empty secret, even for a signature made with the empty key", () => {
    const emptyKeySig = `sha256=${createHmac("sha256", "").update(body).digest("hex")}`;
    expect(verifyWebhookRequest(verify, undefined, { "x-hub-signature-256": emptyKeySig }, body).ok).toBe(false);
    expect(verifyWebhookRequest(verify, "", { "x-hub-signature-256": emptyKeySig }, body).ok).toBe(false);
  });
});

describe("verifyWebhookRequest slackV0", () => {
  const verify = { scheme: "slackV0" as const, secretRef: { name: "s", key: "k" } };
  const now = new Date("2026-10-13T12:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));
  const sig = (t: string): string => `v0=${hex(Buffer.concat([Buffer.from(`v0:${t}:`), body]))}`;

  it("accepts a fresh, correctly signed request", () => {
    expect(verifyWebhookRequest(verify, SECRET, { "x-slack-signature": sig(ts), "x-slack-request-timestamp": ts }, body, now)).toEqual({ ok: true });
  });

  it("rejects a stale timestamp even when the signature over it is valid (replay)", () => {
    const stale = String(Number(ts) - 301);
    const r = verifyWebhookRequest(verify, SECRET, { "x-slack-signature": sig(stale), "x-slack-request-timestamp": stale }, body, now);
    expect(r.ok).toBe(false);
    const edge = String(Number(ts) - 300);
    expect(verifyWebhookRequest(verify, SECRET, { "x-slack-signature": sig(edge), "x-slack-request-timestamp": edge }, body, now).ok).toBe(true);
  });

  it("rejects a signature whose timestamp was swapped", () => {
    const other = String(Number(ts) - 5);
    expect(verifyWebhookRequest(verify, SECRET, { "x-slack-signature": sig(ts), "x-slack-request-timestamp": other }, body, now).ok).toBe(false);
  });

  it("drops x-slack-signature from the envelope by default", () => {
    expect(verifyHeaderName(verify)).toBe("x-slack-signature");
  });
});

describe("verifyWebhookRequest bearer", () => {
  it("default authorization header expects 'Bearer <secret>'", () => {
    const verify = { scheme: "bearer" as const, secretRef: { name: "s", key: "k" } };
    expect(verifyWebhookRequest(verify, SECRET, { authorization: `Bearer ${SECRET}` }, body).ok).toBe(true);
    expect(verifyWebhookRequest(verify, SECRET, { authorization: SECRET }, body).ok).toBe(false);
    expect(verifyWebhookRequest(verify, SECRET, { authorization: "Bearer nope" }, body).ok).toBe(false);
    expect(verifyHeaderName(verify)).toBe("authorization");
  });

  it("a custom header carries the raw secret", () => {
    const verify = { scheme: "bearer" as const, header: "X-Gitlab-Token", secretRef: { name: "s", key: "k" } };
    expect(verifyWebhookRequest(verify, SECRET, { "x-gitlab-token": SECRET }, body).ok).toBe(true);
    expect(verifyWebhookRequest(verify, SECRET, { "x-gitlab-token": `Bearer ${SECRET}` }, body).ok).toBe(false);
    expect(verifyHeaderName(verify)).toBe("x-gitlab-token");
  });
});

describe("slackUrlVerificationChallenge", () => {
  it("only recognizes the url_verification handshake", () => {
    expect(slackUrlVerificationChallenge({ type: "url_verification", challenge: "abc" })).toBe("abc");
    expect(slackUrlVerificationChallenge({ type: "event_callback", challenge: "abc" })).toBeUndefined();
    expect(slackUrlVerificationChallenge({ text: "x" })).toBeUndefined();
  });
});
