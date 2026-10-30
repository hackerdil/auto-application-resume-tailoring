import { describe, expect, it } from "vitest";
import type { CoverLetter } from "@career-agent/domain";
import { createCoverLetterRenderer, renderCoverLetterHtml } from "./cover-letter-render.js";

const F = (n: number) => `0190f0b0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const letter = (paragraphs: CoverLetter["paragraphs"]): CoverLetter => ({
  id: F(1),
  applicationId: F(2),
  jobId: "lever:acme/1",
  createdAt: "2026-10-30T12:00:00.000Z",
  greeting: "Dear Acme Fictional Ltd hiring team,",
  paragraphs,
  closing: "Thank you for considering my application.",
  signature: "Alex Example",
  dropped: [],
  meta: {
    mode: "deterministic",
    generator: null,
    reviewer: null,
    review: "unavailable",
    regenerated: 0,
    promptIds: [],
    notes: [],
  },
});
const seg = (text: string): CoverLetter["paragraphs"][number][number] => ({
  kind: "fact",
  text,
  factIds: [F(9)],
  transformation: "select",
});

describe("cover letter rendering", () => {
  it("escapes text and renders a verified one-page PDF and DOCX", async () => {
    const l = letter([
      [
        {
          kind: "courtesy",
          text: "I am applying for the <b>Engineer</b> position at Acme.",
          factIds: [],
          transformation: null,
        },
      ],
      [
        seg("Built a TypeScript billing service used by 40 internal teams."),
        seg("Reduced CI time from 30 to 12 minutes."),
      ],
    ]);
    expect(renderCoverLetterHtml(l)).toContain("&lt;b&gt;Engineer&lt;/b&gt;");
    const out = await createCoverLetterRenderer().render(l);
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.pageCount).toBe(1);
    expect(out.text).toMatch(/^Dear Acme Fictional Ltd hiring team,\n\nI am applying/);
  }, 60_000);

  it("flags a letter that spills onto a second page", async () => {
    const long = Array.from({ length: 40 }, (_, i) => [
      seg(
        `Fictional accomplishment number ${i} described at length so the letter becomes long enough to need a second page of text overall.`,
      ),
    ]);
    const out = await createCoverLetterRenderer().render(letter(long));
    expect(out.checks.find((c) => c.name === "page_count")?.ok).toBe(false);
  }, 60_000);
});
