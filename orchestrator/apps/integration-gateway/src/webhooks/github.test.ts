import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGithubEvent, verifyGithubSignature, WebhookAuthError } from "./github.js";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  it("accepts a valid signature", () => {
    const body = '{"hello":"world"}';
    expect(() => verifyGithubSignature(body, sign(body, "secret"), "secret")).not.toThrow();
  });

  it("rejects a mismatched signature", () => {
    const body = '{"hello":"world"}';
    expect(() => verifyGithubSignature(body, sign(body, "wrong-secret"), "secret")).toThrow(WebhookAuthError);
  });

  it("rejects a missing signature header", () => {
    expect(() => verifyGithubSignature("{}", undefined, "secret")).toThrow(WebhookAuthError);
  });
});

const repoSender = {
  repository: { owner: { login: "acme" }, name: "widgets" },
  sender: { login: "alice", type: "User" },
};

describe("parseGithubEvent", () => {
  it("ignores an issues.opened event (unlabeled events are always a no-op)", () => {
    const event = parseGithubEvent(
      "issues",
      JSON.stringify({
        action: "opened",
        ...repoSender,
        issue: { number: 42, title: "Add dark mode", body: "Please add a dark theme." },
      }),
    );
    expect(event).toEqual({ kind: "ignored" });
  });

  it("ignores an issue_comment.created event (unlabeled events are always a no-op)", () => {
    const event = parseGithubEvent(
      "issue_comment",
      JSON.stringify({
        action: "created",
        ...repoSender,
        issue: { number: 42 },
        comment: { body: "start work" },
      }),
    );
    expect(event).toEqual({ kind: "ignored" });
  });

  it("flags a Bot sender on issues.labeled", () => {
    const event = parseGithubEvent(
      "issues",
      JSON.stringify({
        action: "labeled",
        repository: { owner: { login: "acme" }, name: "widgets" },
        sender: { login: "agent-controller[bot]", type: "Bot" },
        issue: { number: 42, title: "t", body: "b" },
        label: { name: "ai-triage" },
      }),
    );
    expect(event).toMatchObject({ senderIsBot: true, senderLogin: "agent-controller[bot]" });
  });

  it("parses an issues.labeled event", () => {
    const event = parseGithubEvent(
      "issues",
      JSON.stringify({
        action: "labeled",
        ...repoSender,
        issue: { number: 42, title: "Add dark mode", body: "Please add a dark theme." },
        label: { name: "ai-triage" },
      }),
    );
    expect(event).toEqual({
      kind: "issue-labeled",
      owner: "acme",
      repo: "widgets",
      issueNumber: 42,
      senderLogin: "alice",
      senderIsBot: false,
      title: "Add dark mode",
      body: "Please add a dark theme.",
      labelName: "ai-triage",
    });
  });

  it("parses a pull_request.labeled event (number from pull_request, not issue)", () => {
    const event = parseGithubEvent(
      "pull_request",
      JSON.stringify({
        action: "labeled",
        ...repoSender,
        pull_request: { number: 99, title: "Add dark mode", body: "Implements the dark theme." },
        label: { name: "ai-review" },
      }),
    );
    expect(event).toEqual({
      kind: "pull-request-labeled",
      owner: "acme",
      repo: "widgets",
      prNumber: 99,
      senderLogin: "alice",
      senderIsBot: false,
      title: "Add dark mode",
      body: "Implements the dark theme.",
      labelName: "ai-review",
    });
  });

  it("ignores a pull_request.labeled event with no label payload", () => {
    expect(
      parseGithubEvent(
        "pull_request",
        JSON.stringify({ action: "labeled", ...repoSender, pull_request: { number: 99 } }),
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores a pull_request event with a non-labeled action", () => {
    expect(
      parseGithubEvent(
        "pull_request",
        JSON.stringify({ action: "synchronize", ...repoSender, pull_request: { number: 99 } }),
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores an issues.labeled event with no label payload", () => {
    expect(
      parseGithubEvent(
        "issues",
        JSON.stringify({ action: "labeled", ...repoSender, issue: { number: 42 } }),
      ),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores unrecognized event/action combinations", () => {
    expect(parseGithubEvent("issues", JSON.stringify({ action: "closed", ...repoSender, issue: { number: 1 } }))).toEqual({
      kind: "ignored",
    });
    expect(parseGithubEvent("pull_request", JSON.stringify({ action: "opened" }))).toEqual({ kind: "ignored" });
  });

  it("ignores malformed JSON without throwing", () => {
    expect(parseGithubEvent("issues", "not json")).toEqual({ kind: "ignored" });
  });

  it("ignores payloads missing required fields", () => {
    expect(parseGithubEvent("issues", JSON.stringify({ action: "opened" }))).toEqual({ kind: "ignored" });
  });
});
