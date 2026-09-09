import { describe, expect, it } from "vitest";
import { markdownToProseMirror, parseInline, proseMirrorToMarkdown, type PMNode } from "./markdown.js";

describe("markdownToProseMirror", () => {
  it("produces a doc with a heading and paragraph", () => {
    const doc = markdownToProseMirror("# Title\n\nHello world");
    expect(doc.type).toBe("doc");
    expect(doc.content?.[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    expect(doc.content?.[1]).toMatchObject({ type: "paragraph" });
  });

  it("converts bullet lists", () => {
    const doc = markdownToProseMirror("- one\n- two");
    const list = doc.content?.[0];
    expect(list?.type).toBe("bulletList");
    expect(list?.content).toHaveLength(2);
    expect(list?.content?.[0]).toMatchObject({ type: "listItem" });
  });

  it("converts ordered lists", () => {
    const doc = markdownToProseMirror("1. one\n2. two");
    expect(doc.content?.[0]?.type).toBe("orderedList");
  });

  it("converts fenced code blocks with a language", () => {
    const doc = markdownToProseMirror("```ts\nconst x = 1;\n```");
    expect(doc.content?.[0]).toMatchObject({ type: "codeBlock", attrs: { language: "ts" } });
    expect(doc.content?.[0]?.content?.[0]?.text).toBe("const x = 1;");
  });

  it("converts blockquotes and horizontal rules", () => {
    const doc = markdownToProseMirror("> quoted\n\n---");
    expect(doc.content?.[0]?.type).toBe("blockquote");
    expect(doc.content?.[1]?.type).toBe("horizontalRule");
  });

  it("only emits ProseMirror node types Glyph's validator allows", () => {
    const allowed = new Set([
      "doc", "paragraph", "heading", "bulletList", "orderedList", "listItem",
      "text", "hardBreak", "blockquote", "codeBlock", "horizontalRule", "image",
    ]);
    const walk = (n: PMNode): void => {
      expect(allowed.has(n.type)).toBe(true);
      n.content?.forEach(walk);
    };
    walk(markdownToProseMirror("# H\n\n- a\n- b\n\n> q\n\n```\ncode\n```\n\ntext **bold**"));
  });
});

describe("parseInline", () => {
  it("marks bold, italic, and code", () => {
    expect(parseInline("**b**")).toEqual([{ type: "text", text: "b", marks: [{ type: "bold" }] }]);
    expect(parseInline("*i*")).toEqual([{ type: "text", text: "i", marks: [{ type: "italic" }] }]);
    expect(parseInline("`c`")).toEqual([{ type: "text", text: "c", marks: [{ type: "code" }] }]);
  });

  it("marks links with an href", () => {
    expect(parseInline("[Glyph](https://glyph.example.com)")).toEqual([
      { type: "text", text: "Glyph", marks: [{ type: "link", attrs: { href: "https://glyph.example.com" } }] },
    ]);
  });

  it("keeps plain and marked runs together in order", () => {
    const nodes = parseInline("a **b** c");
    expect(nodes.map((n) => n.text)).toEqual(["a ", "b", " c"]);
    expect(nodes[1]?.marks?.[0]?.type).toBe("bold");
  });
});

describe("proseMirrorToMarkdown", () => {
  it("round-trips a representative document", () => {
    const md = "# Title\n\nHello **world**\n\n- one\n- two\n\n> note\n\n```ts\nx\n```";
    const roundTripped = proseMirrorToMarkdown(markdownToProseMirror(md));
    expect(roundTripped).toContain("# Title");
    expect(roundTripped).toContain("Hello **world**");
    expect(roundTripped).toContain("- one");
    expect(roundTripped).toContain("> note");
    expect(roundTripped).toContain("```ts");
  });

  it("returns an empty string for null content", () => {
    expect(proseMirrorToMarkdown(null)).toBe("");
  });
});
