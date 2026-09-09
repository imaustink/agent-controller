import { describe, expect, it } from "vitest";
import { parseAccessibleRepos } from "./repos.js";

describe("parseAccessibleRepos", () => {
  it("parses the /installation/repositories shape (wrapped in `repositories`)", () => {
    const body = JSON.stringify({
      total_count: 2,
      repositories: [
        { full_name: "acme/widgets", description: "widget service", private: true, default_branch: "main" },
        { full_name: "acme/gadgets", description: null, visibility: "public", default_branch: "trunk" },
      ],
    });
    expect(parseAccessibleRepos(body)).toEqual([
      { fullName: "acme/widgets", description: "widget service", visibility: "private", defaultBranch: "main" },
      { fullName: "acme/gadgets", description: null, visibility: "public", defaultBranch: "trunk" },
    ]);
  });

  it("parses the /user/repos shape (a bare array)", () => {
    const body = JSON.stringify([
      { full_name: "octo/hello", description: "  hi  ", visibility: "public", default_branch: "main" },
    ]);
    expect(parseAccessibleRepos(body)).toEqual([
      { fullName: "octo/hello", description: "hi", visibility: "public", defaultBranch: "main" },
    ]);
  });

  it("derives visibility from `private` when `visibility` is absent", () => {
    const body = JSON.stringify([{ full_name: "octo/pub", private: false }]);
    expect(parseAccessibleRepos(body)[0]).toMatchObject({ fullName: "octo/pub", visibility: "public" });
  });

  it("leaves visibility null when neither field is present", () => {
    const body = JSON.stringify([{ full_name: "octo/unknown" }]);
    expect(parseAccessibleRepos(body)[0]).toEqual({
      fullName: "octo/unknown",
      description: null,
      visibility: null,
      defaultBranch: null,
    });
  });

  it("skips entries without a full_name", () => {
    const body = JSON.stringify([{ description: "no name" }, { full_name: "octo/ok" }]);
    expect(parseAccessibleRepos(body).map((r) => r.fullName)).toEqual(["octo/ok"]);
  });

  it("returns [] for malformed JSON rather than throwing", () => {
    expect(parseAccessibleRepos("not json")).toEqual([]);
    expect(parseAccessibleRepos("")).toEqual([]);
  });

  it("returns [] for an unexpected JSON shape", () => {
    expect(parseAccessibleRepos(JSON.stringify({ message: "Not Found" }))).toEqual([]);
    expect(parseAccessibleRepos(JSON.stringify(42))).toEqual([]);
  });
});
