/**
 * Markdown ⇆ ProseMirror conversion.
 *
 * Glyph stores a note's body as a ProseMirror JSON document (the TipTap editor
 * on the frontend, and `page_contents.content` JSONB on the API side — see
 * glyph/api/internal/handler/content_validator.go for the node/mark allowlist).
 * Agents think in Markdown, so this tool converts Markdown → ProseMirror on
 * write and ProseMirror → Markdown on read.
 *
 * The converter covers the block/inline constructs Glyph's own validator
 * allows: headings, paragraphs, bullet/ordered lists, blockquotes, fenced code
 * blocks, horizontal rules, and the inline marks bold/italic/code/link. It is
 * deliberately small (no tables, images, or nested lists) — enough for agents
 * to author and read back readable notes, not a full CommonMark engine.
 */

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

// ─── Inline: Markdown → ProseMirror text nodes ────────────────────────────────

interface Marker {
  re: RegExp;
  build: (m: RegExpExecArray, inner: PMNode[]) => PMNode[];
  /** When true, the captured group is literal text (no further inline parsing). */
  literal?: boolean;
}

// Ordered by precedence: code spans win over everything (their contents are
// literal), then links, then bold (**/__) before italic (*/_).
const INLINE_MARKERS: Marker[] = [
  {
    re: /`([^`]+)`/,
    literal: true,
    build: (m) => [{ type: "text", text: m[1]!, marks: [{ type: "code" }] }],
  },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    build: (m, inner) => inner.map((n) => withMark(n, { type: "link", attrs: { href: m[2]! } })),
  },
  {
    re: /\*\*([^*]+)\*\*|__([^_]+)__/,
    build: (m, inner) => inner.map((n) => withMark(n, { type: "bold" })),
  },
  {
    re: /\*([^*]+)\*|_([^_]+)_/,
    build: (m, inner) => inner.map((n) => withMark(n, { type: "italic" })),
  },
];

function withMark(node: PMNode, mark: { type: string; attrs?: Record<string, unknown> }): PMNode {
  if (node.type !== "text") return node;
  const marks = node.marks ? [...node.marks] : [];
  if (!marks.some((x) => x.type === mark.type)) marks.push(mark);
  return { ...node, marks };
}

/** Parses inline Markdown into ProseMirror text nodes (with marks). */
export function parseInline(text: string): PMNode[] {
  if (text === "") return [];

  let earliest: { marker: Marker; match: RegExpExecArray } | null = null;
  for (const marker of INLINE_MARKERS) {
    const m = new RegExp(marker.re.source).exec(text);
    if (m && (earliest === null || m.index < earliest.match.index)) {
      earliest = { marker, match: m };
    }
  }

  if (!earliest) return [{ type: "text", text }];

  const { marker, match } = earliest;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  // The first non-undefined capture group is the marked-up content.
  const captured = match.slice(1).find((g) => g !== undefined) ?? "";
  const inner = marker.literal ? [{ type: "text" as const, text: captured }] : parseInline(captured);

  return [...parseInline(before), ...marker.build(match, inner), ...parseInline(after)];
}

// ─── Block: Markdown → ProseMirror ────────────────────────────────────────────

function paragraph(text: string): PMNode {
  return { type: "paragraph", content: parseInline(text) };
}

function listItem(text: string): PMNode {
  return { type: "listItem", content: [paragraph(text)] };
}

/** Converts a Markdown string into a ProseMirror `doc` node Glyph will accept. */
export function markdownToProseMirror(markdown: string): PMNode {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: PMNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line — skip.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block.
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume closing fence (if present)
      content.push({
        type: "codeBlock",
        ...(lang ? { attrs: { language: lang } } : {}),
        content: body.length ? [{ type: "text", text: body.join("\n") }] : [],
      });
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      content.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1]!.length },
        content: parseInline(heading[2]!.trim()),
      });
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines).
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      content.push({ type: "blockquote", content: [paragraph(quoted.join(" ").trim())] });
      continue;
    }

    // Bullet list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(listItem(lines[i]!.replace(/^\s*[-*+]\s+/, "").trim()));
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }

    // Ordered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(listItem(lines[i]!.replace(/^\s*\d+[.)]\s+/, "").trim()));
        i++;
      }
      content.push({ type: "orderedList", content: items });
      continue;
    }

    // Paragraph — gather consecutive plain lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]!)
    ) {
      para.push(lines[i]!.trim());
      i++;
    }
    content.push(paragraph(para.join(" ")));
  }

  return { type: "doc", content };
}

// ─── Block: ProseMirror → Markdown ────────────────────────────────────────────

function markSyntax(node: PMNode): { open: string; close: string; link?: string } {
  let open = "";
  let close = "";
  let link: string | undefined;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        open = `**${open}`;
        close = `${close}**`;
        break;
      case "italic":
        open = `*${open}`;
        close = `${close}*`;
        break;
      case "code":
        open = `\`${open}`;
        close = `${close}\``;
        break;
      case "link":
        link = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        break;
    }
  }
  return { open, close, link };
}

function inlineToMarkdown(nodes: PMNode[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type !== "text") return "";
      const { open, close, link } = markSyntax(node);
      const text = `${open}${node.text ?? ""}${close}`;
      return link !== undefined ? `[${text}](${link})` : text;
    })
    .join("");
}

/** Renders a ProseMirror `doc` (or any node) back to Markdown for reading. */
export function proseMirrorToMarkdown(doc: PMNode | null | undefined): string {
  if (!doc || !doc.content) return "";
  const blocks: string[] = [];

  for (const node of doc.content) {
    switch (node.type) {
      case "heading": {
        const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
        blocks.push(`${"#".repeat(level)} ${inlineToMarkdown(node.content)}`);
        break;
      }
      case "paragraph":
        blocks.push(inlineToMarkdown(node.content));
        break;
      case "blockquote":
        blocks.push(
          (node.content ?? [])
            .map((p) => `> ${inlineToMarkdown(p.content)}`)
            .join("\n"),
        );
        break;
      case "bulletList":
        blocks.push(
          (node.content ?? [])
            .map((li) => `- ${inlineToMarkdown(li.content?.[0]?.content)}`)
            .join("\n"),
        );
        break;
      case "orderedList":
        blocks.push(
          (node.content ?? [])
            .map((li, idx) => `${idx + 1}. ${inlineToMarkdown(li.content?.[0]?.content)}`)
            .join("\n"),
        );
        break;
      case "codeBlock": {
        const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
        const text = (node.content ?? []).map((t) => t.text ?? "").join("");
        blocks.push(`\`\`\`${lang}\n${text}\n\`\`\``);
        break;
      }
      case "horizontalRule":
        blocks.push("---");
        break;
      default:
        // Unknown/unsupported block (e.g. image) — best-effort inline render.
        blocks.push(inlineToMarkdown(node.content));
        break;
    }
  }

  return blocks.filter((b) => b !== "").join("\n\n");
}
