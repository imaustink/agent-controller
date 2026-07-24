import { describe, expect, it, vi } from "vitest";
import { GithubReplyClient, REPLY_MARKER } from "./github-client.js";

const baseConfig = {
  githubToken: "pat_123",
  githubAppId: "",
  githubAppPrivateKey: "",
  githubAppInstallationId: "",
  githubApiUrl: "https://api.github.com",
};

describe("GithubReplyClient.postIssueComment", () => {

  it("posts a marker-prefixed comment using the resolved token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = new GithubReplyClient({ ...baseConfig, fetchImpl });

    await client.postIssueComment("acme", "widgets", 42, "What branch should this target?");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/issues/42/comments",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer pat_123" }),
        body: JSON.stringify({ body: `${REPLY_MARKER}\nWhat branch should this target?` }),
      }),
    );
  });

  it("throws with response detail on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" });
    const client = new GithubReplyClient({ ...baseConfig, fetchImpl });

    await expect(client.postIssueComment("acme", "widgets", 42, "hi")).rejects.toThrow(/403.*forbidden/s);
  });
});

describe("GithubReplyClient.removeIssueLabel", () => {
  it("DELETEs the single label, URL-encoding its name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = new GithubReplyClient({ ...baseConfig, fetchImpl });

    await client.removeIssueLabel("acme", "widgets", 42, "ai triage/pr");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/issues/42/labels/ai%20triage%2Fpr",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ authorization: "Bearer pat_123" }),
      }),
    );
  });

  // The label already being gone is the outcome this call wants, so a 404 is
  // success -- a human removing it mid-run must not fail the turn.
  it("treats a 404 as success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    const client = new GithubReplyClient({ ...baseConfig, fetchImpl });

    await expect(client.removeIssueLabel("acme", "widgets", 42, "ai-triage")).resolves.toBeUndefined();
  });

  it("throws with response detail on any other non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" });
    const client = new GithubReplyClient({ ...baseConfig, fetchImpl });

    await expect(client.removeIssueLabel("acme", "widgets", 42, "ai-triage")).rejects.toThrow(/403.*forbidden/s);
  });
});
