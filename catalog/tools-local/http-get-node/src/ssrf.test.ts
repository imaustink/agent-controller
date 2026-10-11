import { describe, expect, it } from "vitest";
import { assertPublicUrl, isBlockedAddress } from "./ssrf.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, CGNAT and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.9.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv6 loopback, link-local, unique-local and mapped-private", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http\/https/);
    await expect(assertPublicUrl("ftp://example.com")).rejects.toThrow(/http\/https/);
  });

  it("rejects a literal metadata IP URL", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/SSRF guard/);
  });

  it("rejects loopback by IP", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:8080/")).rejects.toThrow(/SSRF guard/);
  });

  it("rejects an unparseable URL", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toThrow(/invalid URL/);
  });
});
