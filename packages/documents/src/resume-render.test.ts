import { describe, expect, it } from "vitest";
import type { TailoredResume } from "@career-agent/domain";
import { checkOrder, createResumeRenderer } from "./resume-render.js";
import { renderResumeHtml } from "./resume-html.js";

const F = (n: number) => `0190f0b0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const bullet = (n: number, text: string) => ({
  id: F(100 + n),
  text,
  sourceFactIds: [F(n)],
  targetRequirementKeys: [],
  transformation: "select" as const,
  verifier: { deterministic: "pass" as const, review: "unavailable" as const, findings: [] },
});

export function sampleResume(over: Partial<TailoredResume> = {}): TailoredResume {
  return {
    id: F(999),
    jobId: "greenhouse:acmefictional/1",
    profileVersion: 1,
    length: "one-page",
    createdAt: "2026-10-29T12:00:00.000Z",
    header: {
      name: "Alex Example",
      contact: ["alex.example@example.com", "Berlin"],
      links: [{ label: "GitHub", url: "https://github.example.com/alex-example" }],
    },
    summary: null,
    experience: [
      {
        roleFactId: F(1),
        heading: "Senior Software Engineer, Acme Fictional Ltd, 2021 - 2025",
        bullets: [
          bullet(2, "Built a TypeScript billing service used by 40 internal teams"),
          bullet(3, "Reduced CI time from 30 to 12 minutes"),
        ],
      },
      {
        roleFactId: F(4),
        heading: "Software Engineer, Globex Example Inc, 2018 - 2021",
        bullets: [bullet(5, "Maintained Python data pipelines")],
      },
    ],
    skills: [
      { text: "TypeScript", factId: F(6) },
      { text: "PostgreSQL", factId: F(7) },
    ],
    education: [{ text: "BSc Computer Science, Example University, 2018", factId: F(8) }],
    certifications: [],
    projects: [],
    languages: [{ text: "German (fluent) – Café-level small talk ✓", factId: F(9) }],
    dropped: [],
    omittedFactIds: [],
    meta: {
      mode: "deterministic",
      generator: null,
      reviewer: null,
      review: "unavailable",
      regenerated: 0,
      promptIds: [],
      notes: [],
    },
    ...over,
  };
}

describe("résumé HTML", () => {
  it("escapes content and uses semantic structure without scripts or external resources", () => {
    const html = renderResumeHtml(
      sampleResume({ header: { name: "<script>alert(1)</script>", contact: [], links: [] } }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(
      /<(img|iframe|link|table)\b|src=|display:\s*none|font-size:\s*[0-7](\.\d+)?pt/i,
    );
    expect(html).toMatch(/<h2>Experience<\/h2><article><h3>/);
  });

  it("checkOrder detects missing and out-of-order text", () => {
    expect(checkOrder("A b C", ["A", "C"]).ok).toBe(true);
    expect(checkOrder("C A", ["A", "C"])).toMatchObject({ ok: false, outOfOrder: ["C"] });
    expect(checkOrder("A", ["A", "Z"])).toMatchObject({ missing: ["Z"] });
  });
});

describe("résumé rendering (headless Chromium)", () => {
  it("renders PDF and DOCX and verifies text, order, links, glyphs, overflow, and length", async () => {
    const out = await createResumeRenderer().render(sampleResume());
    expect(out.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(out.docx.subarray(0, 2).toString()).toBe("PK");
    expect(out.pageCount).toBe(1);
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.checks.map((c) => c.name)).toEqual([
      "pdf_text",
      "pdf_reading_order",
      "pdf_links",
      "glyphs",
      "overflow",
      "docx_text",
      "page_count",
    ]);
  }, 60_000);

  it("flags a one-page résumé that spills onto a second page", async () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      bullet(200 + i, `Delivered fictional improvement number ${i} for the example platform`),
    );
    const out = await createResumeRenderer().render(
      sampleResume({
        experience: [
          { roleFactId: F(1), heading: "Engineer, Example Co, 2020 - 2025", bullets: many },
        ],
      }),
    );
    expect(out.pageCount).toBeGreaterThan(1);
    expect(out.checks.find((c) => c.name === "page_count")).toMatchObject({ ok: false });
    expect(out.checks.find((c) => c.name === "pdf_text")?.ok).toBe(true);
  }, 60_000);
});
