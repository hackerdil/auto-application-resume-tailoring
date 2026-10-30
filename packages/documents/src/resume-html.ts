import type { TailoredResume } from "@career-agent/domain";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * ATS-friendly, accessible résumé HTML: single column, semantic headings and lists, real text (no images, tables,
 * hidden text, or tiny fonts), standard fonts. Every visible string comes from the structured résumé, escaped.
 */
export function renderResumeHtml(
  r: TailoredResume,
  opts: { pageSize?: "A4" | "Letter" } = {},
): string {
  const list = (title: string, items: { text: string }[]) =>
    items.length
      ? `<section><h2>${esc(title)}</h2><ul>${items.map((i) => `<li>${esc(i.text)}</li>`).join("")}</ul></section>`
      : "";
  const header = [
    `<h1>${esc(r.header.name)}</h1>`,
    r.header.contact.length
      ? `<p class="contact">${r.header.contact.map(esc).join(" · ")}</p>`
      : "",
    r.header.links.length
      ? `<p class="contact">${r.header.links.map((l) => `<a href="${esc(l.url)}">${esc(l.label || l.url)}</a>`).join(" · ")}</p>`
      : "",
  ].join("");
  const experience = r.experience.length
    ? `<section><h2>Experience</h2>${r.experience
        .map(
          (e) =>
            `<article><h3>${esc(e.heading)}</h3>${e.bullets.length ? `<ul>${e.bullets.map((b) => `<li>${esc(b.text)}</li>`).join("")}</ul>` : ""}</article>`,
        )
        .join("")}</section>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(r.header.name || "Résumé")}</title>
<style>
@page { size: ${opts.pageSize ?? "A4"}; margin: 16mm 16mm 16mm 16mm; }
html { font-family: Helvetica, Arial, "Liberation Sans", sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; }
body { margin: 0; }
h1 { font-size: 18pt; margin: 0 0 2pt; }
h2 { font-size: 12pt; margin: 12pt 0 4pt; padding-bottom: 2pt; border-bottom: 1px solid #999; text-transform: uppercase; letter-spacing: .04em; }
h3 { font-size: 10.5pt; margin: 8pt 0 2pt; }
p { margin: 0 0 2pt; }
.contact { color: #333; }
ul { margin: 2pt 0 0 14pt; padding: 0; }
li { margin: 0 0 2pt; }
a { color: #111; }
article { break-inside: avoid; }
</style></head>
<body><header>${header}</header><main>${r.summary ? `<section><h2>Summary</h2><p>${esc(r.summary.text)}</p></section>` : ""}${experience}${list("Skills", r.skills)}${list("Projects", r.projects)}${list("Education", r.education)}${list("Certifications", r.certifications)}${list("Languages", r.languages)}</main></body></html>`;
}

/** All visible strings in reading order; used to verify rendered output. */
export function resumeTextSequence(r: TailoredResume): string[] {
  return [
    r.header.name,
    ...r.header.contact,
    ...(r.summary ? [r.summary.text] : []),
    ...r.experience.flatMap((e) => [e.heading, ...e.bullets.map((b) => b.text)]),
    ...r.skills.map((i) => i.text),
    ...r.projects.map((i) => i.text),
    ...r.education.map((i) => i.text),
    ...r.certifications.map((i) => i.text),
    ...r.languages.map((i) => i.text),
  ].filter((s) => s.trim().length > 0);
}
