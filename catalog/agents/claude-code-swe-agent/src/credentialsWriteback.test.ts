import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCredentialsWritebackWatcher, credentialExpiry, persistRefreshedCredentials } from "./credentialsWriteback.js";

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

describe("credentialExpiry", () => {
  it("reads expiresAt from a real credentials shape, and never returns token material", () => {
    const at = Date.UTC(2026, 6, 28, 12, 0, 0);
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: "secret-token", refreshToken: "r", expiresAt: at } });
    const expiry = credentialExpiry(blob);
    expect(expiry).toBe("2026-07-28T12:00:00.000Z");
    expect(expiry).not.toContain("secret-token");
  });

  it("returns null for junk rather than throwing (it only ever feeds a log line)", () => {
    expect(credentialExpiry("not json")).toBeNull();
    expect(credentialExpiry("{}")).toBeNull();
    expect(credentialExpiry(JSON.stringify({ claudeAiOauth: { expiresAt: "nope" } }))).toBeNull();
  });
});

/**
 * The watcher exists because a refresh ROTATES the stored refresh token, so a
 * refresh this pod fails to report does not degrade the link -- it kills it,
 * and only a human re-link recovers. Every test here is a way that used to
 * happen.
 */
describe("createCredentialsWritebackWatcher", () => {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("persists a refresh that happens DURING the turn, without waiting for the turn to end", async () => {
    const home = homeWithCredentials(SEEDED);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const watcher = createCredentialsWritebackWatcher({
      homeDir: home,
      url: "https://gateway.example/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      intervalMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    watcher.start();
    // The CLI refreshes mid-turn. A pod killed right here used to lose this.
    writeFileSync(join(home, ".claude", ".credentials.json"), REFRESHED);
    await settle(60);

    expect(fetchImpl).toHaveBeenCalled();
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      credentialsJson: REFRESHED,
    });
    await watcher.stop();
  });

  it("stores each refresh once, not on every tick", async () => {
    const home = homeWithCredentials(REFRESHED);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const watcher = createCredentialsWritebackWatcher({
      homeDir: home,
      url: "https://gateway.example/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      intervalMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    watcher.start();
    await settle(80); // many ticks
    await watcher.stop();

    // One store for the one refresh: `lastPersisted` advanced, so later ticks
    // (and the final flush) see an unchanged file.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // The gateway restarts on every push to main (release.yml), and a POST that
  // landed in that gap used to lose the refresh permanently.
  it("keeps retrying a failing gateway on later ticks, and stores once it recovers", async () => {
    const home = homeWithCredentials(REFRESHED);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const watcher = createCredentialsWritebackWatcher({
      homeDir: home,
      url: "https://gateway.example/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      intervalMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    watcher.start();
    await settle(120);
    const outcome = await watcher.stop();

    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
    // The blob still got stored -- the whole point.
    expect(outcome === "stored" || outcome === "unchanged").toBe(true);
  });

  it("retries the final flush, so a refresh in the turn's last seconds is not lost to one bad POST", async () => {
    const home = homeWithCredentials(REFRESHED);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const watcher = createCredentialsWritebackWatcher({
      homeDir: home,
      url: "https://gateway.example/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushAttempts: 3,
      flushRetryDelayMs: 5,
      log: () => {},
    });

    // Never started: this is purely the end-of-turn path.
    const outcome = await watcher.stop();

    expect(outcome).toBe("stored");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("says loudly when it gives up, because the link is dead at that point", async () => {
    const logs: string[] = [];
    const watcher = createCredentialsWritebackWatcher({
      homeDir: homeWithCredentials(REFRESHED),
      url: "https://gateway.example/refresh",
      token: "grant-abc",
      seeded: SEEDED,
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response) as unknown as typeof fetch,
      flushAttempts: 2,
      flushRetryDelayMs: 1,
      log: (m) => logs.push(m),
    });

    const outcome = await watcher.stop();

    expect(outcome).toBe("failed");
    expect(logs.join("\n")).toMatch(/GAVE UP/);
    expect(logs.join("\n")).toMatch(/need re-linking/);
  });

  it("is inert when no grant was injected (a non-claude-remote run)", async () => {
    const fetchImpl = vi.fn();
    const watcher = createCredentialsWritebackWatcher({
      homeDir: homeWithCredentials(REFRESHED),
      url: "",
      token: "",
      seeded: SEEDED,
      intervalMs: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    });

    watcher.start();
    await settle(30);
    expect(await watcher.stop()).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
