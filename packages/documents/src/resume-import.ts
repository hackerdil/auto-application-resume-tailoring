import { ValidationError } from "@career-agent/domain";
import { sha256Hex } from "@career-agent/security";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { DEFAULT_ZIP_LIMITS, inspectZip, type ZipLimits } from "./zip-guard.js";

export interface ImportLimits {
  maxBytes: number;
  maxPdfPages: number;
  maxTextChars: number;
  zip: ZipLimits;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxPdfPages: 20,
  maxTextChars: 200_000,
  zip: DEFAULT_ZIP_LIMITS,
};

export type DocumentKind = "pdf" | "docx";

export const MEDIA_TYPES: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export interface ParsedDocument {
  kind: DocumentKind;
  mediaType: string;
  sha256: string;
  byteSize: number;
  pageCount: number | null;
  text: string;
  warnings: string[];
}

/** Content sniffing; the client-provided file name and MIME type are never trusted. */
export function sniffDocument(
  buf: Buffer,
  zipLimits: ZipLimits = DEFAULT_ZIP_LIMITS,
): DocumentKind {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const names = inspectZip(buf, zipLimits).map((e) => e.name);
    if (names.includes("word/document.xml") && names.includes("[Content_Types].xml")) return "docx";
    throw new ValidationError("ZIP file is not a Word (.docx) document.");
  }
  throw new ValidationError("Unsupported file type. Upload a PDF or Word (.docx) résumé.");
}

/** Normalizes extracted text: NFC, no control characters, collapsed spaces, trimmed lines. */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(
      // eslint-disable-next-line no-control-regex -- stripping control and bidi characters is the point
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
      "",
    )
    .split("\n")
    .map((l) => l.replace(/[ \t\u00A0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseResume(
  buf: Buffer,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): Promise<ParsedDocument> {
  if (buf.length === 0) throw new ValidationError("The file is empty.");
  if (buf.length > limits.maxBytes)
    throw new ValidationError(
      `The file is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`,
    );
  const kind = sniffDocument(buf, limits.zip);
  const warnings: string[] = [];
  let raw: string;
  let pageCount: number | null = null;

  try {
    if (kind === "pdf") {
      // unpdf ships a serverless pdf.js build without `new Function`, so font programs are never evaluated.
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      pageCount = pdf.numPages;
      if (pageCount > limits.maxPdfPages)
        throw new ValidationError(`The PDF has more than ${limits.maxPdfPages} pages.`);
      raw = (await extractText(pdf, { mergePages: true })).text;
    } else {
      const result = await mammoth.extractRawText({ buffer: buf });
      raw = result.value;
      if (result.messages.length)
        warnings.push(`${result.messages.length} formatting note(s) while reading the document.`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      "The document could not be read. It may be corrupt or password-protected.",
    );
  }

  let text = normalizeText(raw);
  if (text.length === 0)
    throw new ValidationError("No text found. Scanned (image-only) résumés are not supported yet.");
  if (text.length > limits.maxTextChars) {
    text = text.slice(0, limits.maxTextChars);
    warnings.push("The document text was truncated.");
  }
  return {
    kind,
    mediaType: MEDIA_TYPES[kind],
    sha256: sha256Hex(buf),
    byteSize: buf.length,
    pageCount,
    text,
    warnings,
  };
}
