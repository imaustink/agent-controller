import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { extractDocxText, extractXlsxText } from "./ooxml.js";

/** Builds an in-memory OOXML archive from {path: xml} the way a real .docx/.xlsx is. */
function archive(files: Record<string, string>): Record<string, Uint8Array> {
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  // Round-trip through the same shape the driver hands the extractor.
  return zipped as unknown as Record<string, Uint8Array>;
}

/** The driver passes already-unzipped entries; mirror that directly for the unit test. */
function entries(files: Record<string, string>): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]));
}

describe("extractDocxText", () => {
  it("pulls paragraph text, joining runs and breaking on w:p / w:tab / w:br", () => {
    const docx = entries({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>
            <w:p><w:r><w:t>Col A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Col B</w:t></w:r></w:p>
            <w:p><w:r><w:t>Line one</w:t><w:br/><w:t>line two</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
    });

    expect(extractDocxText(docx)).toBe("Hello world\nCol A\tCol B\nLine one\nline two");
  });

  it("returns empty when there is no document part", () => {
    expect(extractDocxText(entries({ "word/styles.xml": "<x/>" }))).toBe("");
  });

  it("works on a real fflate-produced archive, not just hand-built entries", () => {
    // Guards the whole path the driver uses: zipSync -> (driver would unzipSync) -> extract.
    const zipped = archive({
      "word/document.xml": `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Zipped</w:t></w:r></w:p></w:body></w:document>`,
    });
    expect(extractDocxText(unzipSync(zipped as unknown as Uint8Array))).toBe("Zipped");
  });
});

describe("extractXlsxText", () => {
  it("resolves shared strings, inline strings and numbers into tab-separated rows", () => {
    const xlsx = entries({
      "xl/sharedStrings.xml": `<sst xmlns="urn:x"><si><t>Alpha</t></si><si><t>Beta</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="urn:x"><sheetData>
        <row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row><c r="A2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>Inline</t></is></c></row>
      </sheetData></worksheet>`,
    });

    expect(extractXlsxText(xlsx)).toBe("Alpha\tBeta\n42\tInline");
  });

  it("concatenates multiple sheets and skips empty rows", () => {
    const xlsx = entries({
      "xl/sharedStrings.xml": `<sst xmlns="urn:x"><si><t>One</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="urn:x"><sheetData><row><c r="A1" t="s"><v>0</v></c></row><row/></sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet xmlns="urn:x"><sheetData><row><c r="A1"><v>99</v></c></row></sheetData></worksheet>`,
    });

    expect(extractXlsxText(xlsx)).toBe("One\n\n99");
  });

  it("returns empty when there are no worksheets", () => {
    expect(extractXlsxText(entries({ "xl/sharedStrings.xml": "<sst/>" }))).toBe("");
  });
});
