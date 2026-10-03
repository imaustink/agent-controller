import { describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { kubectlJson } from "../support/k8s.js";

requireMinikubeContext();

/**
 * Review runs must be CODE-ENFORCED read-only, not merely asked to be. The
 * SWE agent container flips to read-only mode (adds `git push`/`gh pr
 * create`/`gh pr merge`/... to its permission deny list AND mints a
 * `contents: "read"` GitHub token) when, and only when, it sees the exact
 * sentinel `SWE-ENFORCED-MODE: review-only` in its goal -- see
 * apps/claude-code-swe-agent/src/claude.ts (REVIEW_MODE_MARKER / isReviewMode /
 * REVIEW_DENY_BASH_PATTERNS) and apps/opencode-swe-agent/src/opencode.ts.
 *
 * The IntegrationRoute CRD carries no env/mode field, so the ONLY per-route
 * channel that reaches the container is the rendered promptTemplate. That makes
 * the single load-bearing, cluster-verifiable fact this suite can assert the
 * one it does: the deployed review routes actually SHIP that sentinel, and the
 * triage/change routes do NOT (so a change run is never silently de-fanged).
 * If a chart edit drops the sentinel from a review route, the enforcement the
 * unit tests cover never triggers in production because the container never
 * learns the run is a review -- exactly the regression this guards, in the same
 * spirit as bridged-agent-routing.e2e.ts (which pins a CR annotation a chart
 * edit could silently drop). The actual push-blocking behaviour, given the
 * signal, is proven hermetically in the agents' own vitest suites.
 */
describe("review IntegrationRoutes ship the read-only enforcement signal", () => {
  const REVIEW_MODE_MARKER = "SWE-ENFORCED-MODE: review-only";

  const REVIEW_ROUTES = ["github-pr-labeled-review", "github-issue-labeled-review"];
  const CHANGE_ROUTES = ["github-pr-labeled-triage", "github-issue-labeled-triage"];

  // A route that this environment does not deploy returns undefined rather than
  // throwing: the PR-labeled routes are not enabled in every values set (the e2e
  // env ships only the issue-labeled pair), so a missing route is SKIPPED, while
  // every route that IS deployed is still asserted. The suite always deploys at
  // least github-issue-labeled-{review,triage}, so this never passes vacuously.
  async function promptTemplateOf(routeName: string): Promise<string | undefined> {
    try {
      const route = await kubectlJson<{ spec?: { promptTemplate?: string } }>(["get", "integrationroute", routeName]);
      return route.spec?.promptTemplate;
    } catch (err) {
      if (/NotFound/i.test(err instanceof Error ? err.message : String(err))) return undefined;
      throw err;
    }
  }

  it.each(REVIEW_ROUTES)("%s carries the read-only sentinel so the agent enforces it", async (routeName) => {
    const template = await promptTemplateOf(routeName);
    if (template === undefined) return; // not deployed in this environment — skip
    expect(template, `${routeName} must ship ${REVIEW_MODE_MARKER} so the run is enforced read-only`).toContain(
      REVIEW_MODE_MARKER,
    );
  });

  it.each(CHANGE_ROUTES)("%s does NOT carry the sentinel, so a change run can still push", async (routeName) => {
    const template = await promptTemplateOf(routeName);
    if (template === undefined) return; // not deployed in this environment — skip
    expect(template, `${routeName} must NOT be accidentally forced read-only`).not.toContain(REVIEW_MODE_MARKER);
  });
});
