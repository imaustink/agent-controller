import { afterEach, describe, expect, it, vi } from "vitest";
import { clip, redact, registerSecret } from "./redact.js";

afterEach(() => {
  vi.resetModules();
});

describe("redact", () => {
  it("scrubs header-prefixed API keys and bearer tokens", () => {
    expect(redact("SIGNOZ-API-KEY: abcdef0123456789")).toBe("[REDACTED]");
    expect(redact("Authorization: Bearer abcdef0123456789xyz")).toContain("[REDACTED]");
  });

  it("scrubs a bare registered key value with no header prefix", () => {
    // The header patterns miss a bare value; registerSecret closes that gap.
    const key = "sk-signoz-9f8e7d6c5b4a3210";
    registerSecret(key);
    const echoed = `SigNoz rejected request: invalid key "${key}" for tenant`;
    const out = redact(echoed);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED]");
  });

  it("ignores short registered values to avoid over-redaction", () => {
    registerSecret("short");
    expect(redact("this short word survives")).toBe("this short word survives");
  });

  it("clip truncates after redacting", () => {
    const key = "abcdefgh12345678ZZZZ";
    registerSecret(key);
    expect(clip(`leak ${key} tail`, 100)).not.toContain(key);
  });
});
