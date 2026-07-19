import { describe, expect, it, vi } from "vitest";
import { GithubReplyClient, REPLY_MARKER } from "./github-client.js";

describe("GithubReplyClient.postIssueComment", () => {
  const baseConfig = {
    githubToken: "pat_123",
    githubAppId: "",
    githubAppPrivateKey: "",
    githubAppInstallationId: "",
    githubApiUrl: "https://api.github.com",
  };

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
