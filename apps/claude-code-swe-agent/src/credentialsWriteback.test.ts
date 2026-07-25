import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { persistRefreshedCredentials } from "./credentialsWriteback.js";

function homeWithCredentials(contents: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "swe-writeback-"));
  if (contents !== null) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), contents);
  }
  return home;
}

const SEEDED = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "r1" } });
const REFRESHED = JSON.stringify({ claudeAiOauth: { accessToken: "new", refreshToken: "r2" } });

describe("persistRefreshedCredentials", () => {
  it("posts the refreshed blob with the per-run grant token when the file changed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const outcome = await persistRefreshedCredentials({
      homeDir: homeWithCredentials(REFRESHED),
      url: "https://gateway.example/claude-auth/api/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toBe("stored");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.example/claude-auth/api/refresh");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer grant-abc");
    expect(JSON.parse(String(init.body))).toEqual({ credentialsJson: REFRESHED });
  });

  it("does nothing when the CLI never refreshed (file identical to the seeded blob)", async () => {
    const fetchImpl = vi.fn();
    const outcome = await persistRefreshedCredentials({
      homeDir: homeWithCredentials(`${SEEDED}\n`),
      url: "https://gateway.example/claude-auth/api/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toBe("unchanged");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is disabled (and silent) when no grant was injected -- e.g. a non-claude-remote run", async () => {
    const fetchImpl = vi.fn();
    const outcome = await persistRefreshedCredentials({
      homeDir: homeWithCredentials(REFRESHED),
      url: "",
      token: "",
      seeded: SEEDED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to store a half-written/invalid credentials file", async () => {
    const fetchImpl = vi.fn();
    const outcome = await persistRefreshedCredentials({
      homeDir: homeWithCredentials('{"claudeAiOauth": {"accessTo'),
      url: "https://gateway.example/claude-auth/api/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toBe("malformed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a failed write-back without throwing -- the turn's work is already done", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const outcome = await persistRefreshedCredentials({
      homeDir: homeWithCredentials(REFRESHED),
      url: "https://gateway.example/claude-auth/api/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toBe("failed");
  });

  it("treats a missing credentials file as nothing to persist", async () => {
    const fetchImpl = vi.fn();
    const outcome = await persistRefreshedCredentials({
      homeDir: homeWithCredentials(null),
      url: "https://gateway.example/claude-auth/api/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome).toBe("unreadable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
