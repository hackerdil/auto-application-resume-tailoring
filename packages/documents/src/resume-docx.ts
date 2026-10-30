import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { TailoredResume } from "@career-agent/domain";

/** DOCX with real headings, bullet lists, and hyperlinks; same content and order as the HTML/PDF. */
export async function renderResumeDocx(r: TailoredResume): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: r.header.name, heading: HeadingLevel.HEADING_1 }),
  ];
  if (r.header.contact.length) children.push(new Paragraph({ text: r.header.contact.join(" · ") }));
  if (r.header.links.length) {
    children.push(
      new Paragraph({
        children: r.header.links.flatMap((l, i) => [
          ...(i ? [new TextRun(" · ")] : []),
          new ExternalHyperlink({
            link: l.url,
            children: [new TextRun({ text: l.label || l.url, style: "Hyperlink" })],
          }),
        ]),
      }),
    );
  }
  const h2 = (t: string) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2 });
  const bullet = (t: string) =>
    new Paragraph({ text: t, numbering: { reference: "bullets", level: 0 } });
  if (r.summary) children.push(h2("Summary"), new Paragraph({ text: r.summary.text }));
  if (r.experience.length) {
    children.push(h2("Experience"));
    for (const e of r.experience)
      children.push(
        new Paragraph({ text: e.heading, heading: HeadingLevel.HEADING_3 }),
        ...e.bullets.map((b) => bullet(b.text)),
      );
  }
  for (const [title, items] of [
    ["Skills", r.skills],
    ["Projects", r.projects],
    ["Education", r.education],
    ["Certifications", r.certifications],
    ["Languages", r.languages],
  ] as const) {
    if (items.length) children.push(h2(title), ...items.map((i) => bullet(i.text)));
  }
  const doc = new Document({
    creator: "Career Agent",
    title: r.header.name || "Résumé",
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              style: { paragraph: { indent: { left: 360, hanging: 240 } } },
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}
