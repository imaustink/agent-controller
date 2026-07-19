import { resolveGithubToken, type GithubAuthConfig } from "@controller-agent/github-app-auth";

/**
 * Marker prefixed onto every comment this gateway posts. Lets
 * `identity.ts`/webhook parsing detect and skip the gateway's own replies
 * even in setups where the sender-type/login check alone isn't reliable
 * (e.g. a PAT-based bot without a distinct GitHub Actor type) -- a second,
 * belt-and-suspenders loop guard.
 */
export const REPLY_MARKER = "<!-- agent-controller:reply -->";

export interface GithubReplyClientOptions extends GithubAuthConfig {
  fetchImpl?: typeof fetch;
}

/** Minimal GitHub REST client: posts a reply comment on an issue. */
export class GithubReplyClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GithubReplyClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async postIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    const token = await resolveGithubToken(this.options);
    const res = await this.fetchImpl(
      `${this.options.githubApiUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body: `${REPLY_MARKER}\n${body}` }),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to post issue comment: ${res.status} ${await res.text()}`);
    }
  }
}
