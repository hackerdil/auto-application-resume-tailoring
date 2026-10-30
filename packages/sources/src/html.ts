import { decodeHTML } from "entities";
import { Parser } from "htmlparser2";
import sanitizeHtml from "sanitize-html";

/** Allowlist sanitizer for job descriptions shown in the UI (docs/THREAT_MODEL.md T16). */
export function sanitizeJobHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "ul",
      "ol",
      "li",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "a",
      "div",
      "span",
    ],
    allowedAttributes: { a: ["href", "rel", "target"] },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      // Transforms run before scheme filtering, so unsafe hrefs are dropped here too; allowedSchemes still applies.
      a: (tagName, attribs) => {
        const href = attribs["href"]?.trim() ?? "";
        return {
          tagName,
          attribs: /^(https?:|mailto:)/i.test(href)
            ? { href, rel: "noopener noreferrer nofollow", target: "_blank" }
            : {},
        };
      },
      h1: "h3",
      h2: "h3",
    },
    disallowedTagsMode: "discard",
  });
}

/** Greenhouse returns description HTML as entity-encoded text. */
export function decodeEntities(s: string): string {
  return decodeHTML(s);
}

const BLOCK = new Set([
  "p",
  "div",
  "br",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "section",
  "tr",
  "table",
]);
const SKIP = new Set(["script", "style", "noscript", "template", "head"]);

/** HTML → plain text with one line per block element and "• " for list items. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let line = "";
  let skipDepth = 0;
  const flush = () => {
    const t = line.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
    line = "";
  };
  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP.has(name)) skipDepth++;
        if (BLOCK.has(name)) flush();
        if (name === "li") line = "• ";
      },
      ontext(text) {
        if (skipDepth === 0) line += text;
      },
      onclosetag(name) {
        if (SKIP.has(name)) skipDepth = Math.max(0, skipDepth - 1);
        if (BLOCK.has(name)) flush();
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  flush();
  return out.filter((l) => l !== "•").join("\n");
}

const REQUIRED_HEADING =
  /\b(requirements?|qualifications|what you('|’)ll (need|bring)|what we('|’)re looking for|must[- ]haves?|you have|about you|minimum|basic qualifications|skills)\b/i;
const PREFERRED_HEADING =
  /\b(preferred|nice[- ]to[- ]haves?|bonus|pluses|desired|ideally|good to have)\b/i;

function isHeading(line: string): boolean {
  return line.length <= 80 && !line.startsWith("•") && !/[.;]$/.test(line);
}

/**
 * Deterministically splits listed qualifications into required and preferred by section headings.
 * Lines outside recognized sections are ignored; nothing is inferred.
 */
export function extractQualifications(text: string): { required: string[]; preferred: string[] } {
  const required: string[] = [];
  const preferred: string[] = [];
  let section: "required" | "preferred" | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (isHeading(line)) {
      section = PREFERRED_HEADING.test(line)
        ? "preferred"
        : REQUIRED_HEADING.test(line)
          ? "required"
          : null;
      continue;
    }
    if (!section || !line.startsWith("•")) continue;
    const item = line.replace(/^•\s*/, "").slice(0, 300);
    const target = section === "required" ? required : preferred;
    if (item && target.length < 30) target.push(item);
  }
  return { required, preferred };
}
