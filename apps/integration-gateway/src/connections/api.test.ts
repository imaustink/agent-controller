import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsApi } from "./api.js";
import type { OidcLoginClient } from "./oidc-login.js";
import type { PrincipalDirectory } from "./principal-directory.js";
import type { ConnectionProvider, ConnectionStatus } from "./providers.js";
import { deriveKey } from "./signed-token.js";

/**
 * The Connections page over real HTTP: sign-in, the email -> chat-subject
 * mapping, CSRF, and the round trip through a provider back to the page.
 */

const INTERNAL = "internal-token";

const nativeFetch = globalThis.fetch;
const fetch: typeof globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return nativeFetch(input, { redirect: "manual", ...init, headers });
};

class MemDirectory implements PrincipalDirectory {
  readonly map = new Map<string, string>();
  async record(email: string, subject: string) {
    this.map.set(email.toLowerCase(), subject);
  }
  async lookup(email: string) {
    return this.map.get(email.toLowerCase());
  }
}

function fakeProvider(id: string, label: string): ConnectionProvider & { state: ConnectionStatus } {
  const p = {
    id,
    label,
    description: `${label} things`,
    state: { state: "not-connected" } as ConnectionStatus,
    status: vi.fn(async () => p.state),
    connect: vi.fn(async () => ({ redirect: `https://${id}.test/authorize` })),
    disconnect: vi.fn(async () => {}),
  };
  return p;
}

/** Collects Set-Cookie values into a Cookie header, the way a browser would. */
class Jar {
  private readonly cookies = new Map<string, string>();
  take(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      if (/Max-Age=0/.test(raw) || !value) this.cookies.delete(name!);
      else this.cookies.set(name!, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

describe("ConnectionsApi", () => {
  let server: Server;
  let base: string;
  let api: ConnectionsApi;
  let directory: MemDirectory;
  let github: ReturnType<typeof fakeProvider>;
  let google: ReturnType<typeof fakeProvider>;
  let claude: ReturnType<typeof fakeProvider>;
  let oidc: { begin: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> };
  let jar: Jar;

  beforeEach(async () => {
    directory = new MemDirectory();
    github = fakeProvider("github", "GitHub");
    google = fakeProvider("google", "Google Drive");
    claude = fakeProvider("claude", "Claude");
    oidc = {
      begin: vi.fn(async () => ({
        authorizeUrl: "https://idp.test/authorize?state=st-1",
        pending: { state: "st-1", nonce: "n-1", codeVerifier: "v-1" },
      })),
      complete: vi.fn(async () => ({ ok: true, email: "ada@example.com", idpSubject: "idp-1" })),
    };
    api = new ConnectionsApi({
      providers: [github, google, claude],
      directory,
      oidc: oidc as unknown as OidcLoginClient,
      cookieKey: deriveKey("secret", "connections-cookie"),
      internalToken: INTERNAL,
      publicBaseUrl: "http://gw.test",
      sessionTtlMs: 60 * 60 * 1000,
    });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://gw.test");
      // Mirrors how GatewayServer consults the hook from a provider callback.
      if (url.pathname === "/fake-provider-callback") {
        const provider = url.searchParams.get("provider") ?? "";
        // `error` is how a provider reports the user declining, as on the real callback.
        const back = url.searchParams.has("error")
          ? api.cancelRedirect(req, res, provider)
          : api.completionRedirect(req, res, provider);
        res.writeHead(back ? 303 : 200, back ? { location: back } : {}).end("linked");
        return;
      }
      void api.handle(req, res, url).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    jar = new Jar();
  });

  afterEach(() => server.close());

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { cookie: jar.header() } });
    jar.take(res);
    return res;
  };
  const post = async (path: string, form: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    jar.take(res);
    return res;
  };
  const recordPrincipal = (email: string, subject: string, token = INTERNAL) =>
    fetch(`${base}/connections/api/principals`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ email, subject }),
    });

  async function signIn(next = "/connections"): Promise<void> {
    const toLogin = await get(next);
    expect(toLogin.status).toBe(302);
    const toIdp = await get(toLogin.headers.get("location")!);
    expect(toIdp.headers.get("location")).toBe("https://idp.test/authorize?state=st-1");
    const back = await get("/connections/callback?state=st-1&code=c-1");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe(next);
  }

  async function csrfFromPage(path = "/connections"): Promise<string> {
    const html = await (await get(path)).text();
    return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  }

  it("sends a signed-out visitor to sign in and back to where they were", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn("/connections?need=google");
    expect(oidc.complete).toHaveBeenCalledWith("c-1", { state: "st-1", nonce: "n-1", codeVerifier: "v-1" });
    expect(jar.has("cx_session")).toBe(true);
  });

  it("refuses a callback whose state does not match the login it started", async () => {
    await get("/connections/login");
    const res = await get("/connections/callback?state=forged&code=c-1");
    expect(res.status).toBe(400);
    expect(oidc.complete).not.toHaveBeenCalled();
    expect(jar.has("cx_session")).toBe(false);
  });

  it("refuses a callback with no login cookie at all", async () => {
    const res = await get("/connections/callback?state=st-1&code=c-1");
    expect(res.status).toBe(400);
  });

  it("explains an unverified email instead of signing in", async () => {
    oidc.complete.mockResolvedValue({ ok: false, reason: "email-unverified" });
    await get("/connections/login");
    const res = await get("/connections/callback?state=st-1&code=c-1");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("isn&#39;t verified");
    expect(jar.has("cx_session")).toBe(false);
  });

  it("never redirects off-site after sign-in", async () => {
    await get("/connections/login?next=//evil.test/phish");
    const back = await get("/connections/callback?state=st-1&code=c-1");
    expect(back.headers.get("location")).toBe("/connections");
  });

  it("asks a user chat hasn't seen yet to send a message first", async () => {
    await signIn();
    const html = await (await get("/connections")).text();
    expect(html).toContain("Send a chat message first");
    expect(github.status).not.toHaveBeenCalled();
  });

  it("lists every provider's status for the mapped chat subject", async () => {
    await recordPrincipal("ADA@example.com", "openwebui:1");
    github.state = { state: "connected", account: "octocat" };
    await signIn();
    const html = await (await get("/connections")).text();

    expect(github.status).toHaveBeenCalledWith("openwebui:1");
    expect(html).toContain("octocat");
    expect(html).toContain("Google Drive");
    expect(html).toContain("ada@example.com");
  });

  it("highlights what chat is waiting on", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn();
    const html = await (await get("/connections?need=google,nonsense")).text();
    expect(html).toContain("Your chat is waiting on <strong>Google Drive</strong>");
    expect(html).not.toContain("nonsense");
  });

  it("escapes what it renders", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    github.state = { state: "connected", account: "<script>alert(1)</script>" };
    await signIn();
    const html = await (await get("/connections")).text();
    expect(html).not.toContain("<script>");
  });

  it("connects through the provider and comes back to the page", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn();
    const csrf = await csrfFromPage("/connections?need=google");

    const res = await post("/connections/google/connect", { csrf, need: "google" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://google.test/authorize");
    expect(google.connect).toHaveBeenCalledWith("openwebui:1");

    // The provider's callback lands on the gateway with the return cookie.
    const back = await get("/fake-provider-callback?provider=google");
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/connections?connected=google&need=google");

    // Consumed: a later link from a chat prompt is not pulled back here.
    const again = await get("/fake-provider-callback?provider=google");
    expect(again.status).toBe(200);
  });

  it("does not redirect a callback for a different provider than the one started", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn();
    await post("/connections/google/connect", { csrf: await csrfFromPage() });
    const back = await get("/fake-provider-callback?provider=github");
    expect(back.status).toBe(200);
  });

  it("rejects a state change without the session's CSRF token", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn();
    expect((await post("/connections/google/disconnect", { csrf: "wrong" })).status).toBe(403);
    expect((await post("/connections/google/connect", {})).status).toBe(403);
    expect(google.disconnect).not.toHaveBeenCalled();
    expect(google.connect).not.toHaveBeenCalled();
  });

  it("disconnects for the signed-in user only", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn();
    const res = await post("/connections/github/disconnect", { csrf: await csrfFromPage() });
    expect(res.headers.get("location")).toBe("/connections?disconnected=github");
    expect(github.disconnect).toHaveBeenCalledWith("openwebui:1");
  });

  it("404s an unknown provider", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn();
    expect((await post("/connections/notion/connect", { csrf: await csrfFromPage() })).status).toBe(404);
  });

  it("sends a signed-out form post to sign in", async () => {
    const res = await post("/connections/github/disconnect", { csrf: "x" });
    expect(res.headers.get("location")).toBe("/connections/login");
    expect(github.disconnect).not.toHaveBeenCalled();
  });

  it("signs out", async () => {
    await recordPrincipal("ada@example.com", "openwebui:1");
    await signIn();
    await post("/connections/logout", { csrf: await csrfFromPage() });
    expect(jar.has("cx_session")).toBe(false);
    expect((await get("/connections")).status).toBe(302);
  });

  describe("principal route", () => {
    it("requires the internal bearer token", async () => {
      expect((await recordPrincipal("ada@example.com", "openwebui:1", "wrong")).status).toBe(401);
      expect(directory.map.size).toBe(0);
    });

    it("rejects a malformed body", async () => {
      expect((await recordPrincipal("not-an-email", "openwebui:1")).status).toBe(400);
      expect((await recordPrincipal("ada@example.com", "")).status).toBe(400);
    });

    it("records the mapping", async () => {
      expect((await recordPrincipal("ada@example.com", "openwebui:1")).status).toBe(204);
      expect(directory.map.get("ada@example.com")).toBe("openwebui:1");
    });
  });

  describe("one-click deep link", () => {
    /** A provider's callback: it lands the credential, then asks where to send the browser. */
    const linked = async (p: ReturnType<typeof fakeProvider>) => {
      p.state = { state: "connected" };
      return get(`/fake-provider-callback?provider=${p.id}`);
    };

    it("signs in on the way and goes straight to the first missing provider's consent", async () => {
      await recordPrincipal("ada@example.com", "openwebui:1");
      // GitHub first whatever order chat asked in: Claude is keyed on its principal.
      await signIn("/connections/link?need=claude,google,github");

      const res = await get("/connections/link?need=claude,google,github");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://github.test/authorize");
      expect(github.connect).toHaveBeenCalledWith("openwebui:1");
      expect(google.connect).not.toHaveBeenCalled();
    });

    it("skips what is connected and walks the rest, then says it's done", async () => {
      await recordPrincipal("ada@example.com", "openwebui:1");
      github.state = { state: "connected", account: "octocat" };
      await signIn();

      // Redirect providers before Claude's paste-the-code page.
      const first = await get("/connections/link?need=claude,github,google");
      expect(first.headers.get("location")).toBe("https://google.test/authorize");
      expect(github.connect).not.toHaveBeenCalled();

      const back = await linked(google);
      expect(back.status).toBe(303);
      expect(back.headers.get("location")).toBe("/connections/link/next");
      const second = await get("/connections/link/next");
      expect(second.headers.get("location")).toBe("https://claude.test/authorize");

      expect((await linked(claude)).headers.get("location")).toBe("/connections/link/next");
      const done = await get("/connections/link/next");
      expect(done.status).toBe(200);
      expect(await done.text()).toContain("You&#39;re all set");
    });

    it("stops the chain on the page when the user declines at a provider", async () => {
      await recordPrincipal("ada@example.com", "openwebui:1");
      await signIn();
      await get("/connections/link?need=google,claude");

      const back = await get("/fake-provider-callback?provider=google&error=access_denied");
      expect(back.status).toBe(303);
      expect(back.headers.get("location")).toBe("/connections?cancelled=google&need=google%2Cclaude");
      expect(claude.connect).not.toHaveBeenCalled();
      // The chain is gone, so nothing carries on from here.
      expect((await get("/connections/link/next")).headers.get("location")).toBe("/connections");
      expect(await (await get("/connections?cancelled=google&need=google,claude")).text()).toContain(
        "Google Drive wasn&#39;t connected",
      );
    });

    it("never sends the user through the same provider twice in one chain", async () => {
      await recordPrincipal("ada@example.com", "openwebui:1");
      await signIn();
      await get("/connections/link?need=google,claude");

      // The callback reported success, but nothing persisted.
      expect((await get("/fake-provider-callback?provider=google")).headers.get("location")).toBe("/connections/link/next");
      const next = await get("/connections/link/next");
      expect(next.headers.get("location")).toBe("/connections?error=connect&need=google%2Cclaude");
      expect(google.connect).toHaveBeenCalledTimes(1);
      expect(claude.connect).not.toHaveBeenCalled();
    });

    it("stops on the page when a provider is blocked", async () => {
      await recordPrincipal("ada@example.com", "openwebui:1");
      claude.connect.mockResolvedValue({ blocked: "Connect GitHub first." } as never);
      await signIn();
      const res = await get("/connections/link?need=claude");
      expect(res.headers.get("location")).toBe("/connections?blocked=claude&need=claude");
      expect(jar.has("cx_return")).toBe(false);
    });

    it("stops on the page when a provider's flow won't start", async () => {
      await recordPrincipal("ada@example.com", "openwebui:1");
      google.connect.mockRejectedValue(new Error("boom"));
      await signIn();
      const res = await get("/connections/link?need=google");
      expect(res.headers.get("location")).toBe("/connections?error=connect&need=google");
    });

    it("goes to the page when there is nothing it can link", async () => {
      await recordPrincipal("ada@example.com", "openwebui:1");
      await signIn();
      expect((await get("/connections/link?need=notion")).headers.get("location")).toBe("/connections");
      expect((await get("/connections/link/next")).headers.get("location")).toBe("/connections");
    });

    it("asks a user chat hasn't seen to send a message first", async () => {
      await signIn();
      const html = await (await get("/connections/link?need=google")).text();
      expect(html).toContain("Send a chat message first");
      expect(google.connect).not.toHaveBeenCalled();
    });

    it("does not let a provider's return token stand in for a chain step", async () => {
      // A page-started (non-chain) link's cookie at /link/next is ignored.
      await recordPrincipal("ada@example.com", "openwebui:1");
      await signIn();
      await post("/connections/google/connect", { csrf: await csrfFromPage() });
      expect((await get("/connections/link/next")).headers.get("location")).toBe("/connections");
      expect(google.connect).toHaveBeenCalledTimes(1);
    });
  });

  it("sends security headers on its pages", async () => {
    const res = await get("/connections/callback?state=x&code=y");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
