import { describe, expect, it } from "vitest";
import { parseOwnerRepoFromRemote } from "./git.js";

describe("parseOwnerRepoFromRemote", () => {
  it("parses an https remote with .git", () => {
    expect(parseOwnerRepoFromRemote("https://github.com/octo/hello.git")).toBe("octo/hello");
  });

  it("parses an https remote without .git", () => {
    expect(parseOwnerRepoFromRemote("https://github.com/octo/hello")).toBe("octo/hello");
  });

  it("strips embedded credentials", () => {
    expect(parseOwnerRepoFromRemote("https://x-access-token:ghs_secret@github.com/octo/hello.git")).toBe("octo/hello");
  });

  it("parses an ssh remote", () => {
    expect(parseOwnerRepoFromRemote("git@github.com:octo/hello.git")).toBe("octo/hello");
  });

  it("returns null for an unrecognized url", () => {
    expect(parseOwnerRepoFromRemote("not a url")).toBeNull();
  });
});
