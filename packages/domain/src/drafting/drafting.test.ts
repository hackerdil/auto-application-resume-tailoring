import { describe, expect, it } from "vitest";
import type { ApplicationField, FieldType } from "../schemas/application.js";
import { CandidateProfile, type SavedAnswer } from "../schemas/profile.js";
import type { VerifiedFact } from "../schemas/fact.js";
import { classifyQuestion } from "./classifier.js";
import { planAnswer, type PlannerContext } from "./planner.js";

describe("question classifier", () => {
  it.each<[string, FieldType, string, string]>([
    ["First name", "text", "identity_name", "auto_fill"],
    ["Email address", "email", "email", "auto_fill"],
    ["Phone", "tel", "phone", "auto_fill"],
    ["LinkedIn Profile", "url", "profile_link", "auto_fill"],
    ["Resume/CV", "file", "resume_file", "auto_fill"],
    ["Cover Letter", "file", "cover_letter_file", "auto_fill"],
    ["Cover letter", "textarea", "cover_letter_text", "needs_review"],
    ["Why do you want to work at Acme?", "textarea", "motivation", "needs_review"],
    ["Tell us about a project you are proud of", "textarea", "experience_story", "needs_review"],
    [
      "Tell us about your open source contributions",
      "textarea",
      "experience_story",
      "needs_review",
    ],
    [
      "Are you legally authorized to work in the United States?",
      "radio",
      "work_authorization",
      "requires_user",
    ],
    [
      "Will you now or in the future require sponsorship for employment visa status?",
      "radio",
      "sponsorship",
      "requires_user",
    ],
    ["What are your salary expectations?", "text", "compensation", "requires_user"],
    ["What is your notice period?", "text", "availability", "requires_user"],
    ["Are you willing to relocate?", "radio", "relocation", "requires_user"],
    ["How did you hear about this job?", "select", "referral_source", "requires_user"],
    ["Were you referred by an employee?", "radio", "referral", "requires_user"],
    ["Have you ever been convicted of a felony?", "radio", "criminal_background", "requires_user"],
    ["Gender", "select", "demographic", "requires_user"],
    ["Are you Hispanic/Latino?", "select", "demographic", "requires_user"],
    ["Veteran Status", "select", "demographic", "requires_user"],
    ["Disability Status", "select", "demographic", "requires_user"],
    ["Date of birth", "date", "date_of_birth", "requires_user"],
    ["Social Security Number", "text", "government_id", "prohibited"],
    [
      "I certify that the information provided is true and complete",
      "checkbox",
      "legal_attestation",
      "prohibited",
    ],
    ["I agree to the Privacy Policy", "checkbox", "consent_terms", "prohibited"],
    ["Signature", "text", "signature", "prohibited"],
    ["Please complete the CAPTCHA", "unknown", "captcha", "prohibited"],
    ["Subscribe me to updates", "checkbox", "unknown", "requires_user"],
    ["Favourite colour?", "text", "unknown", "requires_user"],
    ["When did you graduate?", "text", "education", "needs_review"],
    // Restrictive categories win when a label mixes topics.
    ["Email me about the privacy policy", "checkbox", "consent_terms", "prohibited"],
    ["Please describe your visa situation", "textarea", "sponsorship", "requires_user"],
  ])("%j (%s) → %s / %s", (label, type, category, decision) => {
    expect(classifyQuestion(label, type)).toMatchObject({ category, decision });
  });
});

const F = (n: number) => `0190f0b0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const fact = (
  n: number,
  category: VerifiedFact["category"],
  claim: string,
  loc?: string,
): VerifiedFact => ({
  id: F(n),
  category,
  claim,
  source: "resume",
  sourceArtifactId: F(900),
  ...(loc ? { sourceLocation: loc } : {}),
  verifiedAt: "2026-10-29T00:00:00.000Z",
  allowedTransformations: ["select"],
  sensitive: false,
});
const saved = (n: number, q: string, value: string): SavedAnswer => ({
  id: F(500 + n),
  userId: F(1),
  normalizedQuestion: q,
  value,
  sensitivity: "sensitive",
  createdAt: "2026-10-29T00:00:00.000Z",
});

function ctx(over: Partial<PlannerContext> = {}): PlannerContext {
  return {
    profile: CandidateProfile.parse({
      id: F(2),
      userId: F(1),
      version: 1,
      fullName: { value: "Alex Example", disclosure: "always" },
      email: { value: "alex.example@example.com", disclosure: "always" },
      phone: { value: "+1 555 0142", disclosure: "ask" },
      location: { value: "Berlin", disclosure: "never" },
      links: [{ label: "LinkedIn", url: "https://linkedin.example.com/in/alex-example" }],
      preferences: {},
      demographicDefaults: { useDeclineWhenOffered: true, answers: {} },
      createdAt: "2026-10-29T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
    }),
    savedAnswers: [
      saved(
        1,
        "will you now or in the future require sponsorship for employment visa status",
        "No",
      ),
    ],
    facts: [
      fact(10, "role", "Senior Software Engineer, Acme Fictional Ltd, 2021 - 2025", "line 4"),
      fact(11, "education", "BSc Computer Science, Example University, 2018", "line 10"),
    ],
    approvedResume: { pdfArtifactId: F(700) },
    approvedCoverLetter: null,
    drafts: new Map(),
    ...over,
  };
}
const field = (
  label: string,
  type: FieldType = "text",
  over: Partial<ApplicationField> = {},
): ApplicationField => ({
  id: label,
  label,
  normalizedQuestion: label.toLowerCase(),
  type,
  required: true,
  options: [],
  category: "unknown",
  origin: "manual",
  ...over,
});

describe("answer planner", () => {
  it("fills only explicitly shared owner data automatically", () => {
    expect(planAnswer(field("First name"), ctx())).toMatchObject({
      decision: "auto_fill",
      finalValue: "Alex",
      finalValueSetBy: "system",
      provenance: { kind: "profile" },
    });
    expect(planAnswer(field("Last name"), ctx())).toMatchObject({ finalValue: "Example" });
    expect(planAnswer(field("Email", "email"), ctx())).toMatchObject({
      decision: "auto_fill",
      finalValue: "alex.example@example.com",
    });
    expect(planAnswer(field("Phone", "tel"), ctx())).toMatchObject({
      decision: "needs_review",
      proposedValue: "+1 555 0142",
      finalValue: null,
    });
    expect(planAnswer(field("City"), ctx())).toMatchObject({
      decision: "requires_user",
      proposedValue: null,
    });
    expect(planAnswer(field("LinkedIn", "url"), ctx())).toMatchObject({
      decision: "auto_fill",
      finalValue: "https://linkedin.example.com/in/alex-example",
    });
    expect(planAnswer(field("Resume", "file"), ctx())).toMatchObject({
      decision: "auto_fill",
      provenance: { kind: "artifact", artifactId: F(700) },
    });
    expect(planAnswer(field("Resume", "file"), ctx({ approvedResume: null }))).toMatchObject({
      decision: "requires_user",
    });
  });

  it("leaves optional fields blank when no owner data fills them, and asks for required ones", () => {
    const noLinks = ctx({ profile: CandidateProfile.parse({ ...ctx().profile, links: [] }) });
    const optional = planAnswer(field("GitHub", "url", { required: false }), noLinks);
    expect(optional).toMatchObject({ decision: "auto_fill", finalValue: null });
    expect(optional.notes.join()).toMatch(/left blank/);
    expect(planAnswer(field("GitHub", "url"), noLinks)).toMatchObject({
      decision: "requires_user",
      finalValue: null,
    });
  });

  it("uses only exact saved answers for sensitive questions, always for review", () => {
    const f = field(
      "Will you now or in the future require sponsorship for employment visa status?",
      "radio",
      { options: ["Yes", "No"] },
    );
    expect(planAnswer(f, ctx())).toMatchObject({
      decision: "needs_review",
      proposedValue: "No",
      finalValue: null,
      provenance: { kind: "saved_answer" },
    });
    const similar = planAnswer(
      field("Do you now or in the future require visa sponsorship for employment?", "radio", {
        options: ["Yes", "No"],
      }),
      ctx(),
    );
    expect(similar).toMatchObject({
      decision: "requires_user",
      proposedValue: "No",
      finalValue: null,
      confidence: 0.6,
    });
    expect(similar.notes.join()).toMatch(/similar question/);
    const unrelated = planAnswer(field("What are your salary expectations?"), ctx());
    expect(unrelated).toMatchObject({ decision: "requires_user", proposedValue: null });
  });

  it("never proposes values outside a choice field's options", () => {
    const f = field(
      "Will you now or in the future require sponsorship for employment visa status?",
      "select",
      { options: ["Yes, now", "Not now"] },
    );
    expect(planAnswer(f, ctx())).toMatchObject({ decision: "requires_user", proposedValue: null });
  });

  it("handles demographic questions only through the owner's explicit default", () => {
    const g = field("Gender", "select", {
      options: ["Female", "Male", "Non-binary", "I don't wish to answer"],
    });
    expect(planAnswer(g, ctx())).toMatchObject({
      decision: "needs_review",
      proposedValue: "I don't wish to answer",
      provenance: { kind: "owner_default" },
    });
    const noDefault = ctx({
      profile: CandidateProfile.parse({ ...ctx().profile, demographicDefaults: null }),
    });
    expect(planAnswer(g, noDefault)).toMatchObject({
      decision: "requires_user",
      proposedValue: null,
    });
    expect(
      planAnswer(field("Gender", "select", { options: ["Female", "Male"] }), ctx()),
    ).toMatchObject({ decision: "requires_user", proposedValue: null });
  });

  it("never gives prohibited fields a value, even with a saved answer", () => {
    const c = ctx({ savedAnswers: [saved(2, "i agree to the privacy policy", "yes")] });
    expect(planAnswer(field("I agree to the Privacy Policy", "checkbox"), c)).toMatchObject({
      decision: "prohibited",
      proposedValue: null,
      finalValue: null,
    });
    expect(planAnswer(field("Social Security Number"), c)).toMatchObject({
      decision: "prohibited",
      finalValue: null,
    });
  });

  it("proposes verbatim facts and verified drafts for review", () => {
    expect(planAnswer(field("Current employer"), ctx())).toMatchObject({
      decision: "needs_review",
      proposedValue: "Senior Software Engineer, Acme Fictional Ltd, 2021 - 2025",
      provenance: { kind: "facts", factIds: [F(10)] },
    });
    expect(planAnswer(field("University"), ctx())).toMatchObject({
      proposedValue: "BSc Computer Science, Example University, 2018",
    });
    const why = field("Why do you want to work here?", "textarea");
    expect(planAnswer(why, ctx())).toMatchObject({
      decision: "requires_user",
      proposedValue: null,
    });
    expect(
      planAnswer(why, ctx({ drafts: new Map([[why.id, { text: "Draft.", factIds: [F(10)] }]]) })),
    ).toMatchObject({ decision: "needs_review", proposedValue: "Draft.", finalValue: null });
  });
});
