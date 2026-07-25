import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAuthApi } from "./api.js";
import type { ClaudeTokenRecord, ClaudeTokenStore } from "./store.js";

const BEARER = "test-bearer-token";
const PUBLIC_BASE_URL = "https://gateway.example.com";

/** Minimal fake matching the structural shape both `ClaudeSetupTokenFlows` and `ClaudeLoginFlows` expose -- see `api.ts`'s own `ClaudeAuthFlows` interface. */
function makeFakeFlows() {
  const flowSubjects = new Map<string, string>();
  return {
    start: vi.fn(async (subject: string) => {
      const flowId = `flow-${flowSubjects.size + 1}`;
      flowSubjects.set(flowId, subject);
      return { flowId, authorizeUrl: `https://claude.ai/oauth/authorize?flow=${flowId}` };
    }),
    getSubject: vi.fn((flowId: string) => flowSubjects.get(flowId)),
    submitCode: vi.fn(async (_flowId: string, code: string) => {
      if (code === "bad-code") return { status: "error" as const, message: "OAuth error: Invalid code" };
      return { status: "complete" as const, token: `resolved-for-${code}` };
    }),
  };
}

function makeFakeStore(): ClaudeTokenStore & {
  records: Map<string, ClaudeTokenRecord>;
  grants: Map<string, string>;
} {
  const records = new Map<string, ClaudeTokenRecord>();
  const grants = new Map<string, string>();
  const keyFor = (subject: string, kind: string) => `${kind}:${subject}`;
  return {
    records,
    grants,
    async createWritebackToken(subject) {
      const token = `grant-${grants.size + 1}`;
      grants.set(token, subject);
      return token;
    },
    async resolveWritebackToken(token) {
      return grants.get(token);
    },
    async get(subject, kind = "setup-token") {
      return records.get(keyFor(subject, kind));
    },
    async set(subject, record) {
      records.set(keyFor(subject, record.kind), record);
    },
    async delete(subject, kind = "setup-token") {
      records.delete(keyFor(subject, kind));
    },
    async waitForCompletion(subject, _timeoutMs, kind = "setup-token") {
      return records.get(keyFor(subject, kind));
    },
  };
}

async function startServer(api: ClaudeAuthApi): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    (async () => {
      if (await api.handlePage(req, res, url)) return;
      if (await api.handle(req, res, url)) return;
      res.writeHead(404).end();
    })().catch((err: unknown) => {
      console.error(err);
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

describe("ClaudeAuthApi", () => {
  let setupFlows: ReturnType<typeof makeFakeFlows>;
  let loginFlows: ReturnType<typeof makeFakeFlows>;
  let store: ReturnType<typeof makeFakeStore>;
  let api: ClaudeAuthApi;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    setupFlows = makeFakeFlows();
    loginFlows = makeFakeFlows();
    store = makeFakeStore();
    api = new ClaudeAuthApi(
      setupFlows as unknown as ConstructorParameters<typeof ClaudeAuthApi>[0],
      store,
      BEARER,
      PUBLIC_BASE_URL,
      loginFlows as unknown as ConstructorParameters<typeof ClaudeAuthApi>[4],
    );
    ({ server, port } = await startServer(api));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("default (setup-token) behavior, unaffected by `mode`", () => {
    it("start with no mode uses setup-token flows and returns a mode-less pageUrl", async () => {
      const res = await fetch(`http://localhost:${port}/claude-auth/api/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-1" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { flowId: string; pageUrl: string };
      expect(setupFlows.start).toHaveBeenCalledWith("user-1");
      expect(loginFlows.start).not.toHaveBeenCalled();
      expect(body.pageUrl).not.toContain("mode=");
    });

    it("submitting a code stores a setup-token record and responds success", async () => {
      const startRes = await fetch(`http://localhost:${port}/claude-auth/api/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-2" }),
      });
      const { flowId } = (await startRes.json()) as { flowId: string };

      const submitRes = await fetch(`http://localhost:${port}/claude-auth/${flowId}/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "good-code" }).toString(),
      });
      expect(submitRes.status).toBe(200);
      const html = await submitRes.text();
      expect(html).toContain("linked");

      const stored = await store.get("user-2");
      expect(stored).toEqual({ kind: "setup-token", token: "resolved-for-good-code", createdAt: expect.any(String) });
    });

    it("GET token with no mode returns the setup-token field", async () => {
      await store.set("user-3", { kind: "setup-token", token: "sk-ant-oat01-abc", createdAt: "2026-01-01T00:00:00Z" });
      const res = await fetch(`http://localhost:${port}/claude-auth/api/token?subject=user-3`, {
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: "sk-ant-oat01-abc" });
    });

    it("wait with no mode resolves the setup-token record", async () => {
      await store.set("user-4", { kind: "setup-token", token: "sk-ant-oat01-xyz", createdAt: "2026-01-01T00:00:00Z" });
      const res = await fetch(`http://localhost:${port}/claude-auth/api/wait`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-4" }),
      });
      expect(await res.json()).toEqual({ status: "complete", token: "sk-ant-oat01-xyz" });
    });
  });

  describe("mode=login", () => {
    it("start with mode=login uses login flows and embeds mode in the pageUrl", async () => {
      const res = await fetch(`http://localhost:${port}/claude-auth/api/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-login-1", mode: "login" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { flowId: string; pageUrl: string };
      expect(loginFlows.start).toHaveBeenCalledWith("user-login-1");
      expect(setupFlows.start).not.toHaveBeenCalled();
      expect(body.pageUrl).toContain("mode=login");
    });

    it("submitting a code in login mode stores a login record with credentialsJson", async () => {
      const startRes = await fetch(`http://localhost:${port}/claude-auth/api/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-login-2", mode: "login" }),
      });
      const { flowId } = (await startRes.json()) as { flowId: string };

      const submitRes = await fetch(`http://localhost:${port}/claude-auth/${flowId}/submit?mode=login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "login-code" }).toString(),
      });
      expect(submitRes.status).toBe(200);

      const stored = await store.get("user-login-2", "login");
      expect(stored).toEqual({ kind: "login", credentialsJson: "resolved-for-login-code", createdAt: expect.any(String) });
      // The setup-token record for the same subject must be untouched.
      expect(await store.get("user-login-2")).toBeUndefined();
    });

    it("GET token with mode=login returns credentialsJson, not token", async () => {
      await store.set("user-login-3", { kind: "login", credentialsJson: '{"accessToken":"abc"}', createdAt: "2026-01-01T00:00:00Z" });
      const res = await fetch(`http://localhost:${port}/claude-auth/api/token?subject=user-login-3&mode=login`, {
        headers: { authorization: `Bearer ${BEARER}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ credentialsJson: '{"accessToken":"abc"}' });
    });

    it("wait with mode=login resolves the login record's credentialsJson", async () => {
      await store.set("user-login-4", { kind: "login", credentialsJson: '{"accessToken":"xyz"}', createdAt: "2026-01-01T00:00:00Z" });
      const res = await fetch(`http://localhost:${port}/claude-auth/api/wait`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-login-4", mode: "login" }),
      });
      expect(await res.json()).toEqual({ status: "complete", credentialsJson: '{"accessToken":"xyz"}' });
    });

    it("invalidate with mode=login deletes only the login record", async () => {
      await store.set("user-login-5", { kind: "setup-token", token: "sk-ant-oat01-keep", createdAt: "2026-01-01T00:00:00Z" });
      await store.set("user-login-5", { kind: "login", credentialsJson: '{"accessToken":"drop"}', createdAt: "2026-01-01T00:00:00Z" });

      const res = await fetch(`http://localhost:${port}/claude-auth/api/invalidate`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-login-5", mode: "login" }),
      });
      expect(res.status).toBe(200);
      expect(await store.get("user-login-5", "login")).toBeUndefined();
      expect(await store.get("user-login-5")).toEqual({ kind: "setup-token", token: "sk-ant-oat01-keep", createdAt: "2026-01-01T00:00:00Z" });
    });
  });

  describe("mode=login without loginFlows configured", () => {
    it("501s on start rather than silently falling back to setup-token", async () => {
      const unconfiguredApi = new ClaudeAuthApi(setupFlows as unknown as ConstructorParameters<typeof ClaudeAuthApi>[0], store, BEARER, PUBLIC_BASE_URL);
      const { server: s2, port: p2 } = await startServer(unconfiguredApi);
      try {
        const res = await fetch(`http://localhost:${p2}/claude-auth/api/start`, {
          method: "POST",
          headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
          body: JSON.stringify({ subject: "user-x", mode: "login" }),
        });
        expect(res.status).toBe(501);
        expect(setupFlows.start).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => s2.close(() => resolve()));
      }
    });
  });

  // The credential a Remote Control run authenticates with is a whole
  // ~/.claude/.credentials.json copied into an ephemeral pod HOME. The CLI
  // refreshes it there -- rotating the refresh token, killing the stored copy --
  // and the refreshed file dies with the pod. These two routes are how the run
  // hands the refreshed file back, so a link outlives its first access token.
  describe("credential write-back", () => {
    async function mintGrant(subject: string): Promise<{ token: string; url: string }> {
      const res = await fetch(`http://localhost:${port}/claude-auth/api/writeback-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { token: string; url: string };
    }

    it("mints a grant (bearer-gated) whose url points at the refresh route", async () => {
      const grant = await mintGrant("user-wb-1");
      expect(grant.token).toBeTruthy();
      expect(grant.url).toBe(`${PUBLIC_BASE_URL}/claude-auth/api/refresh`);
    });

    it("refuses to mint a grant without the master bearer", async () => {
      const res = await fetch(`http://localhost:${port}/claude-auth/api/writeback-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-wb-2" }),
      });
      expect(res.status).toBe(401);
    });

    it("stores the refreshed blob against the grant's subject", async () => {
      await store.set("user-wb-3", { kind: "login", credentialsJson: '{"claudeAiOauth":{"accessToken":"old"}}', createdAt: "2026-01-01T00:00:00Z" });
      const grant = await mintGrant("user-wb-3");
      const refreshed = '{"claudeAiOauth":{"accessToken":"new","refreshToken":"rotated"}}';

      const res = await fetch(`http://localhost:${port}/claude-auth/api/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ credentialsJson: refreshed }),
      });

      expect(res.status).toBe(200);
      expect((await store.get("user-wb-3", "login"))?.credentialsJson).toBe(refreshed);
    });

    it("takes the subject from the grant, never from the request body", async () => {
      await store.set("victim", { kind: "login", credentialsJson: '{"claudeAiOauth":"victim-blob"}', createdAt: "2026-01-01T00:00:00Z" });
      const grant = await mintGrant("user-wb-4");

      const res = await fetch(`http://localhost:${port}/claude-auth/api/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "victim", credentialsJson: '{"claudeAiOauth":"attacker-blob"}' }),
      });

      expect(res.status).toBe(200);
      expect((await store.get("victim", "login"))?.credentialsJson).toBe('{"claudeAiOauth":"victim-blob"}');
      expect((await store.get("user-wb-4", "login"))?.credentialsJson).toBe('{"claudeAiOauth":"attacker-blob"}');
    });

    it("401s an unknown or expired grant", async () => {
      const res = await fetch(`http://localhost:${port}/claude-auth/api/refresh`, {
        method: "POST",
        headers: { authorization: "Bearer not-a-real-grant", "content-type": "application/json" },
        body: JSON.stringify({ credentialsJson: "{}" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects a body that isn't a credentials file, rather than clobbering a working link with junk", async () => {
      const existing = '{"claudeAiOauth":{"accessToken":"keep-me"}}';
      await store.set("user-wb-5", { kind: "login", credentialsJson: existing, createdAt: "2026-01-01T00:00:00Z" });
      const grant = await mintGrant("user-wb-5");

      const res = await fetch(`http://localhost:${port}/claude-auth/api/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ credentialsJson: '{"claudeAiOauth": {"accessTo' }),
      });

      expect(res.status).toBe(400);
      expect((await store.get("user-wb-5", "login"))?.credentialsJson).toBe(existing);
    });

    it("reports 502 when the store silently drops the write (set swallows its own errors)", async () => {
      const grant = await mintGrant("user-wb-6");
      store.set = async () => {};

      const res = await fetch(`http://localhost:${port}/claude-auth/api/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ credentialsJson: '{"claudeAiOauth":{"accessToken":"new"}}' }),
      });

      expect(res.status).toBe(502);
    });

    it("leaves the setup-token record untouched when a login blob is refreshed", async () => {
      await store.set("user-wb-7", { kind: "setup-token", token: "sk-ant-oat01-keep", createdAt: "2026-01-01T00:00:00Z" });
      const grant = await mintGrant("user-wb-7");

      await fetch(`http://localhost:${port}/claude-auth/api/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
        body: JSON.stringify({ credentialsJson: '{"claudeAiOauth":{"accessToken":"new"}}' }),
      });

      expect(await store.get("user-wb-7")).toEqual({ kind: "setup-token", token: "sk-ant-oat01-keep", createdAt: "2026-01-01T00:00:00Z" });
    });
  });

  describe("bearer + unknown-flow behavior", () => {
    it("rejects internal API calls without the bearer token", async () => {
      const res = await fetch(`http://localhost:${port}/claude-auth/api/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "user-5" }),
      });
      expect(res.status).toBe(401);
    });

    it("404s the page for an unknown flowId", async () => {
      const res = await fetch(`http://localhost:${port}/claude-auth/does-not-exist`);
      expect(res.status).toBe(404);
    });
  });
});
