import { describe, expect, it } from "vitest";
import {
  catalogIdFor,
  exposureByRemoteName,
  isExposed,
  sanitizeName,
  type MCPServerCustomResource,
  type MCPToolExposure,
} from "./mcp-server-resource.js";

function server(exposure: MCPToolExposure[]): MCPServerCustomResource {
  return {
    metadata: { name: "github-mcp", uid: "u-1" },
    spec: { transport: "streamable-http", url: "https://mcp.example/", exposure },
  };
}

describe("isExposed", () => {
  it("defaults expose to true", () => {
    // The CRD marks expose with +kubebuilder:default=true: an entry that merely
    // names a tool exposes it.
    expect(isExposed({ remoteToolName: "t", allowedRoles: ["r"] })).toBe(true);
    expect(isExposed({ remoteToolName: "t", allowedRoles: ["r"], expose: true })).toBe(true);
    expect(isExposed({ remoteToolName: "t", allowedRoles: ["r"], expose: false })).toBe(false);
  });
});

describe("exposureByRemoteName", () => {
  it("keys entries by remote tool name", () => {
    const map = exposureByRemoteName(
      server([
        { remoteToolName: "search_issues", allowedRoles: ["eng"] },
        { remoteToolName: "create_issue", allowedRoles: ["eng"], expose: false },
      ]),
    );
    expect([...map.keys()]).toEqual(["search_issues", "create_issue"]);
    expect(map.get("create_issue")?.expose).toBe(false);
  });

  it("is empty for a server that exposes nothing", () => {
    expect(exposureByRemoteName(server([])).size).toBe(0);
  });
});

describe("catalogIdFor", () => {
  it("prefers an operator-set toolID", () => {
    expect(
      catalogIdFor("github-mcp", {
        remoteToolName: "search_issues",
        allowedRoles: ["eng"],
        toolID: "gh-search",
      }),
    ).toBe("gh-search");
  });

  it("derives a deterministic sanitized id otherwise", () => {
    // mcp-<server>-<remoteTool>, with the underscore collapsed to a dash.
    expect(
      catalogIdFor("github-mcp", { remoteToolName: "search_issues", allowedRoles: ["eng"] }),
    ).toBe("mcp-github-mcp-search-issues");
  });

  it("is stable across calls for the same inputs", () => {
    const entry = { remoteToolName: "Weird Tool!", allowedRoles: ["eng"] };
    expect(catalogIdFor("srv", entry)).toBe(catalogIdFor("srv", entry));
  });
});

describe("sanitizeName", () => {
  it("lowercases and replaces illegal characters", () => {
    expect(sanitizeName("Search_Issues")).toBe("search-issues");
    expect(sanitizeName("a/b:c")).toBe("a-b-c");
  });

  it("trims and collapses separators", () => {
    expect(sanitizeName("--Foo__Bar--")).toBe("foo-bar");
  });

  it("stays readable for an ordinary name (no hash appended)", () => {
    expect(sanitizeName("mcp-github-search-issues")).toBe("mcp-github-search-issues");
  });

  it("hashes when the result would be illegal — empty or too long", () => {
    const empty = sanitizeName("日本語");
    expect(empty).toMatch(/^mcp-[0-9a-f]{8}$/);

    const long = sanitizeName("x".repeat(300));
    expect(long.length).toBeLessThanOrEqual(253);
    expect(long).toMatch(/-[0-9a-f]{8}$/);

    // Distinct over-long inputs keep distinct ids (the hash is of the original).
    expect(sanitizeName("x".repeat(300))).not.toBe(sanitizeName("y".repeat(300)));
  });
});
