import { parseFragment } from "parse5";

/**
 * Text extraction for Office Open XML (.docx / .xlsx / .xlsm) — the formats the
 * gdrive driver could not index, so a folder of them synced as empty.
 *
 * These are ZIP archives of XML. We unzip with fflate (one ~8KB dependency, zero
 * transitive, no native bindings) and parse the XML parts with parse5 — the same
 * parser the Confluence driver already trusts, so no second XML dependency and no
 * regex-on-markup (the rule readPdf/Confluence both follow: a real parser on
 * untrusted client input, where in a memory-safe runtime the only risk is wrong
 * output, not a memory read).
 *
 * We extract TEXT, which is all RAG needs — formatting, formulas and macros are
 * deliberately dropped. `.xlsm` is structurally a `.xlsx` (the macros live in a
 * separate `vbaProject.bin` we ignore), so the spreadsheet path handles both.
 */

interface OoxmlNode {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: OoxmlNode[];
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const parse = (bytes: Uint8Array): OoxmlNode => parseFragment(decode(bytes)) as unknown as OoxmlNode;

/** The local name, so matching survives whatever parse5 does with the `w:` prefix. */
function local(nodeName: string): string {
  const colon = nodeName.lastIndexOf(":");
  return colon === -1 ? nodeName : nodeName.slice(colon + 1);
}

function attr(node: OoxmlNode, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function childByLocal(node: OoxmlNode, name: string): OoxmlNode | undefined {
  return node.childNodes?.find((c) => local(c.nodeName) === name);
}

/** All text under a node, concatenated (preserves run/rich-text splits). */
function textContent(node: OoxmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  let out = "";
  for (const child of node.childNodes ?? []) out += textContent(child);
  return out;
}

function walk(node: OoxmlNode, visit: (n: OoxmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

// ---- .docx -------------------------------------------------------------------

/**
 * Appends a paragraph's text: `w:t` as text, `w:tab`/`w:br` as tab/newline.
 *
 * Always recurses into children EXCEPT for `w:t` (whose text is taken whole):
 * parse5 is an HTML parser, so a self-closing `<w:br/>`/`<w:tab/>` is read as a
 * non-void open tag that swallows the following siblings as its children —
 * emitting the separator and then recursing is what keeps that swallowed text.
 */
function appendDocxParagraph(node: OoxmlNode, parts: string[]): void {
  const name = local(node.nodeName);
  if (name === "t") {
    parts.push(textContent(node));
    return;
  }
  if (name === "tab") parts.push("\t");
  else if (name === "br" || name === "cr") parts.push("\n");
  for (const child of node.childNodes ?? []) appendDocxParagraph(child, parts);
}

export function extractDocxText(entries: Record<string, Uint8Array>): string {
  const body = entries["word/document.xml"];
  if (!body) return "";

  const parts: string[] = [];
  walk(parse(body), (node) => {
    if (local(node.nodeName) !== "p") return;
    appendDocxParagraph(node, parts);
    parts.push("\n");
  });
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- .xlsx / .xlsm -----------------------------------------------------------

/** The workbook's shared-string table, in document order so cell `t="s"` indices line up. */
function sharedStrings(entries: Record<string, Uint8Array>): string[] {
  const table = entries["xl/sharedStrings.xml"];
  if (!table) return [];
  const strings: string[] = [];
  walk(parse(table), (node) => {
    if (local(node.nodeName) === "si") strings.push(textContent(node));
  });
  return strings;
}

function cellText(cell: OoxmlNode, strings: string[]): string {
  const type = attr(cell, "t");
  if (type === "s") {
    const v = childByLocal(cell, "v");
    const index = Number(v ? textContent(v) : NaN);
    return Number.isInteger(index) ? (strings[index] ?? "") : "";
  }
  if (type === "inlineStr") {
    const is = childByLocal(cell, "is");
    return is ? textContent(is) : "";
  }
  // number, boolean, date, or a formula's cached string value
  const v = childByLocal(cell, "v");
  return v ? textContent(v) : "";
}

function sheetText(bytes: Uint8Array, strings: string[]): string {
  const rows: string[] = [];
  walk(parse(bytes), (node) => {
    if (local(node.nodeName) !== "row") return;
    const cells = (node.childNodes ?? [])
      .filter((c) => local(c.nodeName) === "c")
      .map((c) => cellText(c, strings));
    if (cells.some((value) => value !== "")) rows.push(cells.join("\t"));
  });
  return rows.join("\n");
}

export function extractXlsxText(entries: Record<string, Uint8Array>): string {
  const strings = sharedStrings(entries);
  const sheets = Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();

  const parts: string[] = [];
  for (const name of sheets) {
    const text = sheetText(entries[name]!, strings);
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n\n").trim();
}
