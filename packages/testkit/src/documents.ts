// Generates small, fictional test documents in memory so no binary fixtures need to be committed.
import { crc32, deflateRawSync } from "node:zlib";

/** WinAnsiEncoding code points above Latin-1 that résumés commonly use. */
const WIN_ANSI: Record<string, number> = {
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "€": 0x80,
};

/** Encodes text for a WinAnsi-encoded font as a latin1 "byte string", escaping PDF string delimiters. */
const escapePdf = (s: string) =>
  Array.from(s, (ch) => {
    const code = WIN_ANSI[ch] ?? (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 0x3f);
    return String.fromCharCode(code);
  })
    .join("")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

/** Minimal valid PDF: one page per entry in `pages`, each line drawn with Helvetica. */
export function makePdf(pages: readonly (readonly string[])[]): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1: catalog, 2: pages, 3: font; then per page: content stream + page object.
  let next = 4;
  const pageObjs: string[] = [];
  for (const lines of pages) {
    const content = [
      "BT",
      "/F1 11 Tf",
      "72 760 Td",
      "14 TL",
      ...lines.map((l) => `(${escapePdf(l)}) Tj T*`),
      "ET",
    ].join("\n");
    const contentId = next++;
    const pageId = next++;
    pageIds.push(pageId);
    pageObjs[contentId] =
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
    pageObjs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  for (let i = 4; i < next; i++) objects[i] = pageObjs[i] ?? "null";

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < next; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i] ?? "null"}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let i = 1; i < next; i++) out += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Override the declared uncompressed size (to simulate zip bombs without allocating them). */
  declaredSize?: number;
}

/** Minimal ZIP writer (deflate), enough for DOCX fixtures and archive-limit tests. */
export function makeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const compressed = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const size = e.declaredSize ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function makeDocx(paragraphs: readonly string[]): Buffer {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join("")}</w:body></w:document>`;
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    { name: "word/document.xml", data: Buffer.from(doc) },
  ]);
}

/** A fictional résumé used across tests. Contact data uses reserved example domains and 555-01xx numbers. */
export const FICTIONAL_RESUME_LINES = [
  "Alex Example",
  "alex.example@example.com | +1 555 0142 | https://github.example.com/alex-example",
  "Experience",
  "Senior Software Engineer, Acme Fictional Ltd, 2021 - 2025",
  "• Built a TypeScript billing service used by 40 internal teams",
  "• Reduced CI time from 30 to 12 minutes",
  "Software Engineer, Globex Example Inc, 2018 - 2021",
  "- Maintained Python data pipelines",
  "Education",
  "BSc Computer Science, Example University, 2018",
  "Skills: TypeScript, Python, PostgreSQL",
] as const;
