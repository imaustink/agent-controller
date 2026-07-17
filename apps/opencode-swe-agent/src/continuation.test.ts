import { describe, expect, it } from "vitest";
import { extractContinuationToken } from "./continuation.js";

describe("extractContinuationToken", () => {
  it("strips a leading marker and returns the token and remaining text", () => {
    const result = extractContinuationToken("<!-- continuation: repo=owner/repo branch=main session=abc -->\n\ndo the thing");
    expect(result).toEqual({ token: "repo=owner/repo branch=main session=abc", text: "do the thing" });
  });

  it("returns a null token and the original text when no marker is present", () => {
    const result = extractContinuationToken("do the thing");
    expect(result).toEqual({ token: null, text: "do the thing" });
  });

  it("only matches a marker at the very start of the string", () => {
    const result = extractContinuationToken("do the thing\n<!-- continuation: repo=owner/repo -->");
    expect(result.token).toBeNull();
  });
});
