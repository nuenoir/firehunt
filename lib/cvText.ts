// lib/cvText.ts
// SERVER-ONLY. Pulls plain text out of an uploaded CV so the AI can read it.
// PDFs go through unpdf (a serverless build of Mozilla's pdf.js); Word .docx files
// go through mammoth. Old binary .doc files and scanned (image-only) PDFs can't be
// read as text, and we say so clearly instead of guessing.

import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export type CvKind = "pdf" | "docx" | "doc" | "unknown";

export type CvTextResult =
  | { ok: true; text: string; kind: "pdf" | "docx" }
  | { ok: false; reason: "unsupported" | "empty" | "unreadable"; message: string };

/** Decide the file type from its first bytes (trusting content over the name). */
export function detectCvKind(bytes: Uint8Array, name: string, mime: string): CvKind {
  const startsWith = (...sig: number[]) =>
    sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x25, 0x50, 0x44, 0x46)) return "pdf"; // %PDF
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return "docx"; // PK.. (zip container)
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0)) return "doc"; // legacy Word (OLE2)
  const lower = name.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".doc") && !lower.endsWith(".docx")) return "doc";
  return "unknown";
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractCvText(
  bytes: Uint8Array,
  name: string,
  mime: string,
  minChars = 200,
): Promise<CvTextResult> {
  const kind = detectCvKind(bytes, name, mime);
  if (kind === "doc" || kind === "unknown") {
    return {
      ok: false,
      reason: "unsupported",
      message:
        "This CV format can't be read. Upload it again as a PDF or .docx file.",
    };
  }

  try {
    let raw = "";
    if (kind === "pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      raw = text;
    } else {
      const { value } = await mammoth.extractRawText({
        buffer: Buffer.from(bytes),
      });
      raw = value;
    }
    const text = tidy(raw);
    if (text.length < minChars) {
      return {
        ok: false,
        reason: "empty",
        message:
          "Almost no text could be read from this CV (it may be a scanned image). Upload a text-based PDF or .docx.",
      };
    }
    return { ok: true, text, kind };
  } catch {
    return {
      ok: false,
      reason: "unreadable",
      message: "This CV file could not be opened. It may be corrupted.",
    };
  }
}
