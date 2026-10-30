import mammoth from "mammoth";
import { Document, Packer, Paragraph } from "docx";
import {
  coverLetterText,
  type CoverLetter,
  type CoverLetterRenderer,
  type RenderCheck,
  type RenderedLetter,
} from "@career-agent/domain";
import {
  checkOrder,
  inspectPdf,
  printHtml,
  shortList,
  type RendererOptions,
} from "./resume-render.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain, single-page business letter; every string comes from the structured letter, escaped. */
export function renderCoverLetterHtml(
  l: CoverLetter,
  opts: { pageSize?: "A4" | "Letter" } = {},
): string {
  const paras = l.paragraphs.map((p) => `<p>${p.map((s) => esc(s.text)).join(" ")}</p>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cover letter</title>
<style>
@page { size: ${opts.pageSize ?? "A4"}; margin: 22mm; }
html { font-family: Helvetica, Arial, "Liberation Sans", sans-serif; font-size: 11pt; line-height: 1.45; color: #111; }
body { margin: 0; }
p { margin: 0 0 10pt; }
</style></head>
<body><main><p>${esc(l.greeting)}</p>${paras}<p>${esc(l.closing)}</p>${l.signature ? `<p>${esc(l.signature)}</p>` : ""}</main></body></html>`;
}

export async function renderCoverLetterDocx(l: CoverLetter): Promise<Buffer> {
  const children = [
    l.greeting,
    ...l.paragraphs.map((p) => p.map((s) => s.text).join(" ")),
    l.closing,
    l.signature,
  ]
    .filter((t) => t.trim())
    .map((t) => new Paragraph({ text: t, spacing: { after: 200 } }));
  const doc = new Document({
    creator: "Career Agent",
    title: "Cover letter",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

export function createCoverLetterRenderer(opts: RendererOptions = {}): CoverLetterRenderer {
  return {
    async render(letter: CoverLetter): Promise<RenderedLetter> {
      const html = renderCoverLetterHtml(letter, { pageSize: opts.pageSize ?? "A4" });
      const { pdf, overflow } = await printHtml(html, opts);
      const { pageCount, text: pdfText } = await inspectPdf(pdf);
      const docx = await renderCoverLetterDocx(letter);
      const docxText = (await mammoth.extractRawText({ buffer: docx })).value;
      const expected = [
        letter.greeting,
        ...letter.paragraphs.flat().map((s) => s.text),
        letter.closing,
        letter.signature,
      ].filter((t) => t.trim());
      const pdfOrder = checkOrder(pdfText, expected);
      const docxOrder = checkOrder(docxText, expected);
      const checks: RenderCheck[] = [
        {
          name: "pdf_text",
          ok: pdfOrder.ok,
          detail: pdfOrder.ok
            ? "All letter text is extractable from the PDF, in order."
            : `PDF text problems: ${shortList([...pdfOrder.missing, ...pdfOrder.outOfOrder])}`,
        },
        {
          name: "glyphs",
          ok: !pdfText.includes("�"),
          detail: pdfText.includes("�")
            ? "Some characters could not be rendered."
            : "No missing glyphs.",
        },
        {
          name: "overflow",
          ok: overflow.length === 0,
          detail: overflow.length
            ? `Text overflows its box: ${shortList(overflow)}`
            : "No clipped or overflowing text.",
        },
        {
          name: "docx_text",
          ok: docxOrder.ok,
          detail: docxOrder.ok
            ? "DOCX contains all letter text in order."
            : `DOCX problems: ${shortList([...docxOrder.missing, ...docxOrder.outOfOrder])}`,
        },
        {
          name: "page_count",
          ok: pageCount === 1,
          detail:
            pageCount === 1
              ? "Fits on one page."
              : `${pageCount} pages; a cover letter should fit on one page.`,
        },
      ];
      return { html, pdf, docx, text: coverLetterText(letter), pageCount, checks };
    },
  };
}
