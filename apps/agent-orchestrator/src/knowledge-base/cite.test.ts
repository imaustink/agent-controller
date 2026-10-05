import { describe, expect, it } from "vitest";
import { finalizeCitations, linkCitations, type CitedSource } from "./cite.js";

const sources: CitedSource[] = [
  { n: 1, title: "Project Details as of August 2026", url: "https://wiki/details" },
  { n: 2, title: "SNC Session 2 Assessment", url: "https://wiki/session2" },
  { n: 3, title: "Project Details as of August 2026", url: "https://wiki/details" }, // second passage, same page
];

describe("linkCitations", () => {
  it("turns markers into titled links", () => {
    expect(linkCitations("The demo runs through September, per [1].", sources)).toEqual({
      text: "The demo runs through September, per [Project Details as of August 2026](https://wiki/details).",
      used: 1,
    });
  });

  it("joins a cluster and collapses passages of the same page", () => {
    for (const input of ["Scope grew [1][2][3].", "Scope grew [1], [2], [3].", "Scope grew [1, 2, 3]."]) {
      expect(linkCitations(input, sources)).toEqual({
        text: "Scope grew [Project Details as of August 2026](https://wiki/details), [SNC Session 2 Assessment](https://wiki/session2).",
        used: 2,
      });
    }
  });

  // The model only writes numbers; one nobody issued is an invented citation.
  it("drops a number that names no source", () => {
    expect(linkCitations("Auth uses OIDC [9]. Budget is tight [2][9].", sources)).toEqual({
      text: "Auth uses OIDC. Budget is tight [SNC Session 2 Assessment](https://wiki/session2).",
      used: 1,
    });
  });

  it("leaves Markdown link syntax alone", () => {
    const input = "See [1](https://elsewhere) and the [docs][1].";
    expect(linkCitations(input, sources)).toEqual({ text: input, used: 0 });
  });

  // The model often glues a marker to the word before it ("…with SNC[1].").
  // The substituted title must not be. PARITY:
  // TestLinkCitationsSeparatesALinkGluedToTheWordBeforeIt.
  it.each([
    ["Regular emails with SNC[2].", "Regular emails with SNC [SNC Session 2 Assessment](https://wiki/session2)."],
    [
      "Scope grew[1][2].",
      "Scope grew [Project Details as of August 2026](https://wiki/details), [SNC Session 2 Assessment](https://wiki/session2).",
    ],
    ["Done.[2]", "Done. [SNC Session 2 Assessment](https://wiki/session2)"],
    ["Already spaced, per [2].", "Already spaced, per [SNC Session 2 Assessment](https://wiki/session2)."],
    ["Inside parens ([2]).", "Inside parens ([SNC Session 2 Assessment](https://wiki/session2))."],
    ["[2] opens the answer.", "[SNC Session 2 Assessment](https://wiki/session2) opens the answer."],
    ["First line.\n[2] starts one.", "First line.\n[SNC Session 2 Assessment](https://wiki/session2) starts one."],
  ])("spaces a link off the word it is glued to: %j", (input, want) => {
    expect(linkCitations(input, sources).text).toBe(want);
  });

  it("escapes titles and URLs", () => {
    expect(linkCitations("x [1]", [{ n: 1, title: "Q3 [draft]", url: "https://w/a b(c)" }]).text).toBe(
      "x [Q3 \\[draft\\]](https://w/a%20b%28c%29)",
    );
  });
});

describe("finalizeCitations", () => {
  it("links inline without a list when the model cited", () => {
    const out = finalizeCitations("Two engagements are active [1][2].", sources, ["2 source(s) are outside your access."]);

    expect(out).toContain("[Project Details as of August 2026](https://wiki/details)");
    expect(out).not.toContain("Sources:");
    expect(out).toContain("What this answer could not see:\n- 2 source(s) are outside your access.");
  });

  // The safety net: never shipped uncited just because the model wrote no markers.
  it("falls back to a de-duplicated list when nothing was cited", () => {
    const out = finalizeCitations("Two engagements are active.", sources, []);

    expect(out).toContain(
      "Sources:\n- [Project Details as of August 2026](https://wiki/details)\n- [SNC Session 2 Assessment](https://wiki/session2)\n",
    );
    expect(out.split("https://wiki/details").length - 1).toBe(1);
  });

  it("leaves an answer with no sources alone", () => {
    expect(finalizeCitations("Nothing matched.", [], [])).toBe("Nothing matched.");
  });
});
