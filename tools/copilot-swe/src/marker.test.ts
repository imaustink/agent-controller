import { describe, expect, it } from "vitest";
import { parseSweMarker, renderSweMarker, type SweMarker } from "./marker.js";

describe("parseSweMarker", () => {
  it("returns no marker when absent", () => {
    const { marker, instruction } = parseSweMarker("add a health check endpoint");
    expect(marker).toBeNull();
    expect(instruction).toBe("add a health check endpoint");
  });

  it("parses a full marker and strips it from the instruction", () => {
    const input = "<!-- swe: repo=octo/hello branch=feature-x pr=12 session=abc-123 -->\n\nadd tests";
    const { marker, instruction } = parseSweMarker(input);
    expect(marker).toEqual<SweMarker>({ repo: "octo/hello", branch: "feature-x", pr: "12", session: "abc-123" });
    expect(instruction).toBe("add tests");
  });

  it("parses a marker without a PR", () => {
    const input = "<!-- swe: repo=octo/hello branch=feature-x session=abc -->\nkeep going";
    const { marker } = parseSweMarker(input);
    expect(marker?.pr).toBeNull();
  });

  it("treats a malformed repo as no marker (fail closed)", () => {
    const input = "<!-- swe: repo=not-a-repo branch=x session=abc -->\ndo it";
    const { marker, instruction } = parseSweMarker(input);
    expect(marker).toBeNull();
    expect(instruction).toBe(input);
  });

  it("rejects a non-numeric pr", () => {
    const input = "<!-- swe: repo=o/r branch=x pr=abc session=s -->\ndo it";
    expect(parseSweMarker(input).marker).toBeNull();
  });
});

describe("renderSweMarker", () => {
  it("round-trips through parse", () => {
    const marker: SweMarker = { repo: "octo/hello", branch: "feat/thing", pr: "7", session: "sess-1" };
    const rendered = renderSweMarker(marker);
    expect(rendered.startsWith("<!-- swe:")).toBe(true);
    const { marker: parsed } = parseSweMarker(`${rendered}next instruction`);
    expect(parsed).toEqual(marker);
  });

  it("omits pr when null", () => {
    const rendered = renderSweMarker({ repo: "o/r", branch: "b", pr: null, session: "s" });
    expect(rendered).not.toContain("pr=");
  });
});
