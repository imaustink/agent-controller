import { describe, expect, it } from "vitest";
import { deriveKey, signToken, verifyToken } from "./signed-token.js";

const KEY = deriveKey("state-secret", "connections-cookie");
const NOW = Date.parse("2026-10-03T12:00:00Z");

describe("signed tokens", () => {
  it("round-trips a payload", () => {
    const token = signToken({ email: "a@example.com" }, "session", KEY, NOW + 60_000);
    expect(verifyToken(token, "session", KEY, NOW)).toMatchObject({ email: "a@example.com" });
  });

  it("rejects an expired token", () => {
    const token = signToken({ email: "a@example.com" }, "session", KEY, NOW + 60_000);
    expect(verifyToken(token, "session", KEY, NOW + 61_000)).toBeUndefined();
  });

  it("rejects a tampered payload", () => {
    const token = signToken({ email: "a@example.com" }, "session", KEY, NOW + 60_000);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ email: "victim@example.com", exp: NOW / 1000 + 60 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, "session", KEY, NOW)).toBeUndefined();
  });

  // A login cookie must never be accepted as a session, though both share a key.
  it("rejects a token minted for another purpose", () => {
    const token = signToken({ email: "a@example.com", csrf: "x" }, "login", KEY, NOW + 60_000);
    expect(verifyToken(token, "session", KEY, NOW)).toBeUndefined();
  });

  it("rejects a token signed with another key", () => {
    const token = signToken({ email: "a@example.com" }, "session", deriveKey("other", "connections-cookie"), NOW + 60_000);
    expect(verifyToken(token, "session", KEY, NOW)).toBeUndefined();
  });

  it("rejects garbage", () => {
    expect(verifyToken("not-a-token", "session", KEY, NOW)).toBeUndefined();
    expect(verifyToken("a.b.c", "session", KEY, NOW)).toBeUndefined();
  });
});
