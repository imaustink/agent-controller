import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AuthorizationError,
  fetchCollaboratorPermission,
  fetchGithubUser,
  grantCollaboratorAccess,
  resolveDelegatedWriteToken,
} from "./delegatedWrite.js";

let privateKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKey = pair.privateKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGithubUser", () => {
  it("returns the login on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ login: "octocat", id: 42 }) });
    const result = await fetchGithubUser("ghu_abc", "https://api.github.com", fetchMock);
    expect(result).toEqual({ login: "octocat", id: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghu_abc" }) }),
    );
  });

  it("throws on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "Bad credentials" });
    await expect(fetchGithubUser("bad", "https://api.github.com", fetchMock)).rejects.toThrow(/401.*Bad credentials/s);
  });
});

describe("fetchCollaboratorPermission", () => {
  it("returns the permission on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ permission: "write" }) });
    const result = await fetchCollaboratorPermission(
      "ghu_abc",
      "acme",
      "widgets",
      "octocat",
      "https://api.github.com",
      fetchMock,
    );
    expect(result).toBe("write");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/collaborators/octocat/permission",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghu_abc" }) }),
    );
  });

  it("returns 'none' on a 404 rather than throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "Not Found" });
    const result = await fetchCollaboratorPermission(
      "ghu_abc",
      "acme",
      "widgets",
      "octocat",
      "https://api.github.com",
      fetchMock,
    );
    expect(result).toBe("none");
  });

  it("throws on other non-2xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    await expect(
      fetchCollaboratorPermission("ghu_abc", "acme", "widgets", "octocat", "https://api.github.com", fetchMock),
    ).rejects.toThrow(/500.*boom/s);
  });
});

describe("grantCollaboratorAccess", () => {
  it("PUTs the collaborator invite with the given permission", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await grantCollaboratorAccess("ghs_install", "acme", "widgets", "octocat", "https://api.github.com", "push", fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/collaborators/octocat",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer ghs_install" }),
        body: JSON.stringify({ permission: "push" }),
      }),
    );
  });

  it("throws on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "nope" });
    await expect(
      grantCollaboratorAccess("ghs_install", "acme", "widgets", "octocat", "https://api.github.com", "push", fetchMock),
    ).rejects.toThrow(/403.*nope/s);
  });
});

describe("resolveDelegatedWriteToken", () => {
  const appCreds = () => ({ appId: "1", privateKey, installationId: "999" });

  it("mints a repo-scoped installation token when the user has write access", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ login: "octocat", id: 42 }) }) // fetchGithubUser
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ permission: "write" }) }) // fetchCollaboratorPermission
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ token: "ghs_scoped", expires_at: "" }) }); // mintInstallationToken
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveDelegatedWriteToken({
      userToken: "ghu_abc",
      repo: "acme/widgets",
      githubApiUrl: "https://api.github.com",
      appCreds: appCreds(),
      now: 1_700_000_000_000,
    });

    expect(result).toEqual({ token: "ghs_scoped", githubLogin: "octocat", githubId: 42 });
    const mintCall = fetchMock.mock.calls[2]!;
    expect(mintCall[0]).toBe("https://api.github.com/app/installations/999/access_tokens");
    expect(JSON.parse(mintCall[1].body)).toEqual({ repositories: ["widgets"] });
  });

  it("throws AuthorizationError when the user lacks write access", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ login: "octocat", id: 42 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ permission: "read" }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveDelegatedWriteToken({
        userToken: "ghu_abc",
        repo: "acme/widgets",
        githubApiUrl: "https://api.github.com",
        appCreds: appCreds(),
        now: 1_700_000_000_000,
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("throws AuthorizationError when the user has no access at all", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ login: "octocat", id: 42 }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => "Not Found" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveDelegatedWriteToken({
        userToken: "ghu_abc",
        repo: "acme/widgets",
        githubApiUrl: "https://api.github.com",
        appCreds: appCreds(),
        now: 1_700_000_000_000,
      }),
    ).rejects.toThrow(AuthorizationError);
  });
});
