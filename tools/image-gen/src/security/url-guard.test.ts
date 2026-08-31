import { describe, it, expect } from "vitest";
import { isBlockedIp, assertUrlAllowed, UrlGuardError } from "./url-guard.js";

describe("isBlockedIp", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata endpoint
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  }

  const allowed = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  }

  it("fails closed on garbage", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("assertUrlAllowed", () => {
  it("rejects non-http protocols", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(UrlGuardError);
    await expect(assertUrlAllowed("data:text/plain,hi")).rejects.toBeInstanceOf(UrlGuardError);
    await expect(assertUrlAllowed("ftp://example.com")).rejects.toBeInstanceOf(UrlGuardError);
  });

  it("rejects literal internal IP hosts without DNS", async () => {
    await expect(assertUrlAllowed("http://127.0.0.1/")).rejects.toBeInstanceOf(UrlGuardError);
    await expect(assertUrlAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      UrlGuardError,
    );
    await expect(assertUrlAllowed("http://[::1]:8080/")).rejects.toBeInstanceOf(UrlGuardError);
  });

  it("rejects malformed URLs", async () => {
    await expect(assertUrlAllowed("not a url")).rejects.toBeInstanceOf(UrlGuardError);
  });

  it("allows a public literal IP", async () => {
    const safe = await assertUrlAllowed("http://1.1.1.1/");
    expect(safe.addresses).toContain("1.1.1.1");
  });
});
