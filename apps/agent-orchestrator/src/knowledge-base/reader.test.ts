import { describe, expect, it, vi } from "vitest";
import { CorpusReader } from "./reader.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

/**
 * ONE read tool per knowledge base, so the corpus travels in the input rather
 * than in the choice of tool.
 */
const tool = {
  id: "kb:globex/read",
  name: "Read from GLOBEX",
  description: "…",
  allowedRoles: ["reader", "lead"],
  knowledgeBaseExec: {
    knowledgeBaseId: "globex",
    displayName: "GLOBEX",
    operation: "read",
    members: [
      {
        id: "globex-confluence",
        label: "GLOBEX Confluence",
        collection: "c1",
        allowedRoles: ["reader"],
        identityProviders: ["atlassian"],
      },
      {
        id: "globex-leads",
        label: "#globex-leads",
        collection: "c2",
        allowedRoles: ["lead"],
        identityProviders: ["slack"],
      },
    ],
    disclosePartialVisibility: true,
  },
} as unknown as ToolDescriptor;

const READER = { subject: "openwebui:42", roles: ["reader"] };

// No default parameter for the credential: `reader(http, undefined)` must mean
// "nothing linked", and a default would silently turn that into the happy path.
function reader(fetchImpl: typeof fetch, ...credential: [{ token: string } | undefined] | []) {
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
  it("resolves the corpus from the reference and reads as the caller", async () => {
    const http = vi
      .fn()
      .mockResolvedValue(ok({ markdown: "Auth notes", url: "https://wiki/x", title: "Auth" }));

    const result = await reader(http as unknown as typeof fetch).read(
      tool,
      "globex-confluence/12345",
      READER,
    );

    // /documents/ rather than /resources/: the first is bounded by who is
    // asking, the second by the corpus's scope.
    expect(http.mock.calls[0]![0]).toBe(
      "http://broker.test/corpora/globex-confluence/documents/12345",
    );
    expect((http.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer orchestrator-secret",
      "x-delegated-token": "user-token",
    });
    expect(result.result).toContain("Auth notes");
  });

  it("splits on the FIRST slash, so a Slack reference keeps its channel", async () => {
    // A Slack id is itself `<channel>/<ts>`; splitting on the last separator
    // would send the broker a timestamp with no channel.
    const http = vi.fn().mockResolvedValue(ok({ markdown: "" }));
    await reader(http as unknown as typeof fetch).read(tool, "globex-leads/C123/1.1", {
      subject: "s",
      roles: ["lead"],
    });

    expect(http.mock.calls[0]![0]).toBe(
      "http://broker.test/corpora/globex-leads/documents/C123%2F1.1",
    );
  });

  it("refuses a member this caller holds no role for", async () => {
    // Union to invoke, per member to read. This is OUR policy layer: a caller
    // whose Slack account can see the channel still may not reach it through a
    // corpus the operator scoped to other roles.
    const http = vi.fn();
    const result = await reader(http as unknown as typeof fetch).read(
      tool,
      "globex-leads/1.1",
      READER,
    );

    expect(result.result).toContain("do not have access");
    expect(http).not.toHaveBeenCalled();
  });

  it("names what IS readable when the model picks a corpus outside the base", async () => {
    const result = await reader(vi.fn() as unknown as typeof fetch).read(
      tool,
      "someone-elses-corpus/1",
      READER,
    );

    // A dead end the model can recover from rather than one it cannot.
    expect(result.result).toContain("globex-confluence (GLOBEX Confluence)");
  });

  it("rejects a reference with no corpus", async () => {
    const result = await reader(vi.fn() as unknown as typeof fetch).read(tool, "12345", READER);
    expect(result.result).toContain("not a readable reference");
  });

  it("asks for a link rather than falling back to the ingestion credential", async () => {
    // Reading live on the service credential would answer a different
    // question, permissively (docs/adr/0040).
    const http = vi.fn();
    const result = await reader(http as unknown as typeof fetch, undefined).read(
      tool,
      "globex-confluence/1",
      READER,
    );

    expect(result.needsLink).toBe(true);
    expect(result.result).toContain("link the account");
    expect(http).not.toHaveBeenCalled();
  });

  it("returns a refusal as PROSE the model can act on", async () => {
    const http = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "page 9 is not visible to this user",
      json: async () => ({}),
    } as Response);

    const result = await reader(http as unknown as typeof fetch).read(
      tool,
      "globex-confluence/9",
      READER,
    );

    expect(result.result).toContain("refused that read (403)");
    expect(result.needsLink).toBeUndefined();
  });

  it("raises when the broker cannot be reached at all", async () => {
    // Distinct from a refusal: we did not get an answer, and reporting one
    // would be inventing it.
    const http = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      reader(http as unknown as typeof fetch).read(tool, "globex-confluence/1", READER),
    ).rejects.toThrow(/unreachable/);
  });

  it("refuses a tool that is not a knowledge-base read", async () => {
    const bare = { ...tool, knowledgeBaseExec: undefined } as unknown as ToolDescriptor;
    await expect(
      reader(vi.fn() as unknown as typeof fetch).read(bare, "a/b", READER),
    ).rejects.toThrow(/not a knowledge-base read/);
  });
});
