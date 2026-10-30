import mammoth from "mammoth";
import { chromium, type Browser } from "playwright";
import { extractText, getDocumentProxy } from "unpdf";
import type {
  RenderCheck,
  RenderedResume,
  ResumeRenderer,
  TailoredResume,
} from "@career-agent/domain";
import { renderResumeDocx } from "./resume-docx.js";
import { renderResumeHtml, resumeTextSequence } from "./resume-html.js";

/**
 * Launches Playwright's bundled Chromium, or the system Chrome when the bundled build is not installed.
 * Either way the browser is headless with a fresh, temporary profile (never the user's everyday profile).
 */
export async function launchPrintBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    if (err instanceof Error && /Executable doesn't exist/i.test(err.message))
      return chromium.launch({ headless: true, channel: "chrome" });
    throw err;
  }
}

const squash = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\s­]+/g, "")
    .toLowerCase();

/** Every string appears, in order, in the extracted text (whitespace-insensitive). */
export function checkOrder(
  extracted: string,
  expected: readonly string[],
): { ok: boolean; missing: string[]; outOfOrder: string[] } {
  const hay = squash(extracted);
  const missing: string[] = [];
  const outOfOrder: string[] = [];
  let pos = 0;
  for (const s of expected) {
    const needle = squash(s);
    const at = hay.indexOf(needle, pos);
    if (at >= 0) pos = at + needle.length;
    else if (hay.includes(needle)) outOfOrder.push(s);
    else missing.push(s);
  }
  return { ok: missing.length === 0 && outOfOrder.length === 0, missing, outOfOrder };
}

const short = (xs: string[]) =>
  xs
    .slice(0, 3)
    .map((x) => `"${x.slice(0, 60)}"`)
    .join(", ") + (xs.length > 3 ? "…" : "");

export interface RendererOptions {
  pageSize?: "A4" | "Letter";
  launch?: () => Promise<Browser>;
}

/** Prints self-contained HTML to a tagged PDF in an offline, isolated context and reports overflowing elements. */
export async function printHtml(
  html: string,
  opts: RendererOptions = {},
): Promise<{ pdf: Buffer; overflow: string[] }> {
  const browser = await (opts.launch ?? launchPrintBrowser)();
  try {
    const context = await browser.newContext({ offline: true, javaScriptEnabled: true });
    // The templates reference no external resources; block anything that tries.
    await context.route("**/*", (route) =>
      route.request().url().startsWith("data:") ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    // Evaluated in the page; kept as a string because this package does not compile against DOM types.
    const raw: unknown = await page.evaluate(
      `Array.from(document.querySelectorAll("h1,h2,h3,p,li")).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => (el.textContent || "").slice(0, 60))`,
    );
    const overflow = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string")
      : ["(overflow check failed)"];
    const pdf = Buffer.from(
      await page.pdf({
        format: opts.pageSize ?? "A4",
        printBackground: false,
        preferCSSPageSize: true,
        tagged: true,
        outline: true,
      }),
    );
    await context.close();
    return { pdf, overflow };
  } finally {
    await browser.close();
  }
}

/** Page count, extracted text, and link targets of a PDF. */
export async function inspectPdf(
  pdf: Buffer,
): Promise<{ pageCount: number; text: string; links: Set<string> }> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const text = (await extractText(doc, { mergePages: true })).text;
  const links = new Set<string>();
  for (let i = 1; i <= doc.numPages; i++) {
    const annotations = (await (await doc.getPage(i)).getAnnotations()) as {
      subtype?: string;
      url?: string;
    }[];
    for (const a of annotations) if (a.subtype === "Link" && a.url) links.add(a.url);
  }
  return { pageCount: doc.numPages, text, links };
}

export const shortList = (xs: string[]) =>
  xs
    .slice(0, 3)
    .map((x) => `"${x.slice(0, 60)}"`)
    .join(", ") + (xs.length > 3 ? "…" : "");

export function createResumeRenderer(opts: RendererOptions = {}): ResumeRenderer {
  return {
    async render(resume: TailoredResume): Promise<RenderedResume> {
      const html = renderResumeHtml(resume, { pageSize: opts.pageSize ?? "A4" });
      const printed = await printHtml(html, opts);
      const { pdf, overflow } = printed;
      const { pageCount, text: pdfText, links } = await inspectPdf(pdf);
      const docx = await renderResumeDocx(resume);
      const docxText = (await mammoth.extractRawText({ buffer: docx })).value;

      const expected = resumeTextSequence(resume);
      const pdfOrder = checkOrder(pdfText, expected);
      const docxOrder = checkOrder(docxText, expected);
      const missingLinks = resume.header.links.filter(
        (l) => !links.has(l.url) && !links.has(`${l.url}/`),
      );
      const checks: RenderCheck[] = [
        {
          name: "pdf_text",
          ok: pdfOrder.missing.length === 0,
          detail: pdfOrder.missing.length
            ? `Missing from the PDF text layer: ${short(pdfOrder.missing)}`
            : "All résumé text is extractable from the PDF.",
        },
        {
          name: "pdf_reading_order",
          ok: pdfOrder.outOfOrder.length === 0,
          detail: pdfOrder.outOfOrder.length
            ? `Out of order in the PDF: ${short(pdfOrder.outOfOrder)}`
            : "PDF text reads in résumé order (ATS-readable).",
        },
        {
          name: "pdf_links",
          ok: missingLinks.length === 0,
          detail: missingLinks.length
            ? `Links not clickable in the PDF: ${missingLinks.map((l) => l.url).join(", ")}`
            : resume.header.links.length
              ? `All ${resume.header.links.length} link(s) are clickable.`
              : "No links to check.",
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
            ? `Text overflows its box: ${short(overflow)}`
            : "No clipped or overflowing text.",
        },
        {
          name: "docx_text",
          ok: docxOrder.ok,
          detail: docxOrder.ok
            ? "DOCX contains all résumé text in order."
            : `DOCX problems: ${short([...docxOrder.missing, ...docxOrder.outOfOrder])}`,
        },
        {
          name: "page_count",
          ok: resume.length === "full" || pageCount === 1,
          detail: `${pageCount} page(s)${resume.length === "one-page" && pageCount > 1 ? "; a one-page résumé was requested" : ""}.`,
        },
      ];
      return { html, pdf, docx, pageCount, checks };
    },
  };
}
