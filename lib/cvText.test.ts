// Feeds REAL PDF and .docx files (generated here) through the actual parsers, so we
// know CV text extraction works with the libraries as deployed.

import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detectCvKind, extractCvText } from "./cvText";

const SENTENCE =
  "Ran thirty customer interviews to reshape the onboarding flow and cut drop-off at sign-up. ";
const LONG_TEXT = SENTENCE.repeat(4).trim(); // comfortably over the 200-char minimum

/** A minimal but valid one-page PDF containing `text` (no parentheses allowed). */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 10 Tf 20 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

/** A minimal valid .docx containing the given paragraphs. */
async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
      .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("detectCvKind", () => {
  it("trusts file contents over the file name", () => {
    expect(detectCvKind(makePdf("hello world"), "cv.txt", "")).toBe("pdf");
    expect(detectCvKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]), "cv.pdf", "")).toBe("docx");
    expect(detectCvKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0]), "cv.docx", "")).toBe("doc");
  });

  it("falls back to the name or MIME type, and reports unknown otherwise", () => {
    expect(detectCvKind(new Uint8Array([1, 2, 3]), "x.pdf", "")).toBe("pdf");
    expect(detectCvKind(new Uint8Array([1, 2, 3]), "x", "application/pdf")).toBe("pdf");
    expect(detectCvKind(new Uint8Array([1, 2, 3]), "x.doc", "")).toBe("doc");
    expect(detectCvKind(new Uint8Array([1, 2, 3]), "notes.txt", "text/plain")).toBe("unknown");
  });
});

describe("extractCvText", () => {
  it("reads text out of a real PDF", async () => {
    const result = await extractCvText(makePdf(LONG_TEXT), "cv.pdf", "application/pdf");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("pdf");
      expect(result.text).toContain("customer interviews");
      expect(result.text).toContain("onboarding flow");
    }
  });

  it("reads text out of a real .docx, keeping paragraphs apart", async () => {
    const docx = await makeDocx([LONG_TEXT, "Skills: SQL, Python and Figma, used daily in product work."]);
    const result = await extractCvText(docx, "cv.docx", "");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("docx");
      expect(result.text).toContain("customer interviews");
      expect(result.text).toMatch(/\n/);
      expect(result.text).toContain("Skills: SQL, Python");
    }
  });

  it("explains that old binary .doc files can't be read", async () => {
    const legacy = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]);
    const result = await extractCvText(legacy, "cv.doc", "application/msword");
    expect(result).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("reports an almost-empty document (e.g. a scanned image PDF) clearly", async () => {
    const result = await extractCvText(makePdf("Hi"), "scan.pdf", "application/pdf");
    expect(result).toMatchObject({ ok: false, reason: "empty" });
  });

  it("reports a corrupted file instead of throwing", async () => {
    const garbage = new TextEncoder().encode("%PDF-1.4 this is not really a pdf at all");
    const result = await extractCvText(garbage, "cv.pdf", "application/pdf");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["unreadable", "empty"]).toContain(result.reason);
  });
});
