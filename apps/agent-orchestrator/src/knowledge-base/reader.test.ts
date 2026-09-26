import { describe, expect, it, vi } from "vitest";
import { CorpusReader } from "./reader.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const tool = {
  id: "corpus:globex-confluence/get",
  name: "Read from GLOBEX Confluence",
  description: "…",
  allowedRoles: ["reader"],
  corpusGetExec: {
    corpusId: "globex-confluence",
    label: "GLOBEX Confluence",
    identityProviders: ["atlassian"],
  },
} as unknown as ToolDescriptor;

// No default parameter for the credential: `reader(http, undefined)` must mean
// "nothing linked", and a default would silently turn that into the happy path.
function reader(
  fetchImpl: typeof fetch,
  ...credential: [{ token: string; principals?: string[] } | undefined] | []
) {
  const resolved = credential.length === 0 ? { token: "user-token" } : credential[0];
  return new CorpusReader({
    brokerUrl: "http://broker.test/",
    brokerToken: "orchestrator-secret",
    credentials: { delegatedToken: vi.fn().mockResolvedValue(resolved) },
    fetchImpl,
  });
}

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as Response;

describe("read", () => {
  it("calls the broker's GET face with the CALLER's token", async () => {
    const http = vi.fn().mockResolvedValue(ok({ body: { title: "Auth" }, url: "https://wiki/x" }));

    const result = await reader(http as unknown as typeof fetch).read(tool, "pages/12345", "openwebui:42");

    expect(http.mock.calls[0]![0]).toBe("http://broker.test/corpora/globex-confluence/api/pages/12345");
    // The orchestrator holds no third-party credential: it forwards one it did
    // not mint and cannot widen.
    expect((http.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer orchestrator-secret",
      "x-delegated-token": "user-token",
    });
    expect(result.result).toContain("https://wiki/x");
    expect(result.result).toContain("Auth");
  });

  it("escapes each path segment, not the whole path", async () => {
    // Escaping the whole thing encodes the separators and turns a two-segment
    // request into one meaningless one.
    const http = vi.fn().mockResolvedValue(ok({ body: {} }));
    await reader(http as unknown as typeof fetch).read(tool, "pages/12345/children", "s");

    expect(http.mock.calls[0]![0]).toContain("/api/pages/12345/children");
  });

  it("asks for a link rather than falling back to the ingestion credential", async () => {
    // Reading live on the service credential would answer a different
    // question, permissively (docs/adr/0040).
    const http = vi.fn();
    const result = await reader(http as unknown as typeof fetch, undefined).read(tool, "pages/1", "s");

    expect(result.needsLink).toBe(true);
    expect(result.result).toContain("link the account");
    expect(http).not.toHaveBeenCalled();
  });

  it("returns a refusal as PROSE the model can act on", async () => {
    // A refused path or an unreadable resource is an answer — the model can
    // try a different path, or say the material is unavailable — where a
    // thrown error just ends the turn.
    const http = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "page 9 is outside this corpus's scope",
      json: async () => ({}),
    } as Response);

    const result = await reader(http as unknown as typeof fetch).read(tool, "pages/9", "s");

    expect(result.result).toContain("refused that read (403)");
    expect(result.result).toContain("outside this corpus's scope");
    expect(result.needsLink).toBeUndefined();
  });

  it("raises when the broker cannot be reached at all", async () => {
    // Distinct from a refusal: we did not get an answer, and reporting one
    // would be inventing it.
    const http = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      reader(http as unknown as typeof fetch).read(tool, "pages/1", "s"),
    ).rejects.toThrow(/unreachable/);
  });

  it("refuses a tool carrying no GET spec", async () => {
    const bare = { ...tool, corpusGetExec: undefined } as unknown as ToolDescriptor;
    await expect(reader(vi.fn() as unknown as typeof fetch).read(bare, "x", "s")).rejects.toThrow(
      /no corpus GET spec/,
    );
  });
});
