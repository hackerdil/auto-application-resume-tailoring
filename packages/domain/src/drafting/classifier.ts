import type { AnswerDecision, FieldType, QuestionCategory } from "../schemas/application.js";
import type { Sensitivity } from "../schemas/common.js";

export interface Classification {
  category: QuestionCategory;
  sensitivity: Sensitivity;
  decision: AnswerDecision;
  reason: string;
}

type Rule = [QuestionCategory, RegExp];

/** Checked in order: the most restrictive categories first, so an ambiguous label lands on the safe side. */
const RULES: Rule[] = [
  ["captcha", /\b(captcha|i['’]?m not a robot|are you (a )?human|security check)\b/i],
  [
    "signature",
    /\b(e-?signature|electronic signature|signature|sign (here|below|your name)|type your (full )?name to sign)\b/i,
  ],
  [
    "government_id",
    /\b(social security|ssn|national insurance|nino|passport( number)?|driver['’]?s? licen[cs]e( number)?|tax (id|identification)|tin\b|national id|personal identification number|sin number|bsn|aadhaar)\b/i,
  ],
  [
    "legal_attestation",
    /\b(i (hereby )?(certify|attest|declare|affirm)|certify that|attest that|true and (complete|correct)|to the best of my knowledge)\b/i,
  ],
  [
    "consent_terms",
    /\b(i (agree|consent|accept|acknowledge)|agree to|consent to|terms (of|and) (use|service|conditions)|privacy (policy|notice)|data processing|gdpr|retain my (data|information)|marketing (emails|communications))\b/i,
  ],
  [
    "demographic",
    /\b(gender|sex|pronouns?|race|racial|ethnic\w*|hispanic|latin[oax]|veteran\w*|military (service|status)|disabilit\w*|sexual orientation|transgender|lgbt\w*|religio\w*|marital|pregnan\w*|caste|national origin)\b/i,
  ],
  [
    "date_of_birth",
    /\b(date of birth|birth ?date|dob\b|how old|your age|age range|over (the age of )?18|at least 18)\b/i,
  ],
  [
    "criminal_background",
    /\b(criminal|convicted|conviction|felony|misdemeanou?r|arrest|background check|offen[cs]e)\b/i,
  ],
  [
    "conflict_of_interest",
    /\b(conflict of interest|related to (any|an) employee|relatives? (who )?work)\b/i,
  ],
  ["non_compete", /\b(non-?compete|non-?solicit|restrictive covenant|bound by any agreement)\b/i],
  ["sponsorship", /\b(sponsor(ship)?|visa|h-?1b|work permit (sponsorship)?)\b/i],
  [
    "work_authorization",
    /\b(authori[sz]ed to work|right to work|work authori[sz]ation|eligible to work|legally (able|permitted|authori[sz]ed)|citizenship|citizen|permanent resident|green card)\b/i,
  ],
  [
    "compensation",
    /\b(salary|compensation|pay (expectation|range)|expected (pay|salary|compensation)|desired (pay|salary)|current (salary|pay|compensation)|rate|remuneration|ote\b)\b/i,
  ],
  [
    "availability",
    /\b(start date|when (can|could) you start|notice period|earliest (start|availability)|availability|available to start)\b/i,
  ],
  ["relocation", /\b(relocat\w*|move to)\b/i],
  ["travel", /\b(travel|on-?site .* days|commute|in the office \d)\b/i],
  ["referral", /\b(referred by|referral|who referred|employee referral|know anyone)\b/i],
  ["referral_source", /\b(how did you (hear|find|learn)|where did you (hear|find|see))\b/i],
  ["cover_letter_file", /\bcover letter\b/i],
  ["resume_file", /\b(r[eé]sum[eé]|cv\b|curriculum vitae)\b/i],
  ["email", /\be-?mail\b/i],
  ["phone", /\b(phone|mobile|telephone|cell)\b/i],
  [
    "profile_link",
    /\b(linkedin|github|gitlab|portfolio|website|personal (site|url)|url|blog|twitter|x profile)\b/i,
  ],
  ["identity_name", /\b((first|last|full|given|family|legal|preferred) name|^name$|surname)\b/i],
  [
    "location",
    /\b(city|location|where are you (based|located)|country of residence|current (location|city)|address|postcode|zip)\b/i,
  ],
  [
    "employment_current",
    /\b(current (company|employer|title|role|position)|most recent (employer|title))\b/i,
  ],
  ["education", /\b(school|university|college|degree|education|graduat\w*|gpa|major)\b/i],
  [
    "motivation",
    /\b(why (do you want|are you interested|this (role|company|position))|why .* (us|join)|what (excites|interests|motivates) you|interest in)\b/i,
  ],
  [
    "experience_story",
    /\b(tell us about|describe (a|an|your)|give (an|us an) example|share (a|an) (project|example)|accomplishment|achievement|proud of)\b/i,
  ],
  ["additional_info", /\b(anything else|additional (information|comments)|is there anything)\b/i],
];

const BY_CATEGORY: Record<QuestionCategory, Omit<Classification, "category" | "reason">> = {
  identity_name: { sensitivity: "personal", decision: "auto_fill" },
  email: { sensitivity: "personal", decision: "auto_fill" },
  phone: { sensitivity: "personal", decision: "auto_fill" },
  location: { sensitivity: "personal", decision: "auto_fill" },
  profile_link: { sensitivity: "personal", decision: "auto_fill" },
  resume_file: { sensitivity: "personal", decision: "auto_fill" },
  cover_letter_file: { sensitivity: "none", decision: "auto_fill" },
  cover_letter_text: { sensitivity: "none", decision: "needs_review" },
  employment_current: { sensitivity: "personal", decision: "needs_review" },
  education: { sensitivity: "personal", decision: "needs_review" },
  motivation: { sensitivity: "none", decision: "needs_review" },
  experience_story: { sensitivity: "none", decision: "needs_review" },
  additional_info: { sensitivity: "none", decision: "needs_review" },
  referral_source: { sensitivity: "personal", decision: "requires_user" },
  referral: { sensitivity: "personal", decision: "requires_user" },
  work_authorization: { sensitivity: "sensitive", decision: "requires_user" },
  sponsorship: { sensitivity: "sensitive", decision: "requires_user" },
  compensation: { sensitivity: "sensitive", decision: "requires_user" },
  availability: { sensitivity: "sensitive", decision: "requires_user" },
  relocation: { sensitivity: "sensitive", decision: "requires_user" },
  travel: { sensitivity: "sensitive", decision: "requires_user" },
  conflict_of_interest: { sensitivity: "sensitive", decision: "requires_user" },
  non_compete: { sensitivity: "sensitive", decision: "requires_user" },
  criminal_background: { sensitivity: "sensitive", decision: "requires_user" },
  demographic: { sensitivity: "protected", decision: "requires_user" },
  date_of_birth: { sensitivity: "protected", decision: "requires_user" },
  legal_attestation: { sensitivity: "sensitive", decision: "prohibited" },
  consent_terms: { sensitivity: "sensitive", decision: "prohibited" },
  signature: { sensitivity: "sensitive", decision: "prohibited" },
  government_id: { sensitivity: "protected", decision: "prohibited" },
  captcha: { sensitivity: "none", decision: "prohibited" },
  unknown: { sensitivity: "personal", decision: "requires_user" },
};

const REASONS: Partial<Record<QuestionCategory, string>> = {
  captcha: "CAPTCHAs are completed by you in the browser; Career Agent never solves them.",
  signature: "Signatures are given by you directly; Career Agent never signs for you.",
  government_id:
    "Government identifiers are entered by you directly and are never stored or automated.",
  legal_attestation: "Legal declarations are confirmed by you directly in the browser.",
  consent_terms: "Terms and consent checkboxes are ticked by you directly in the browser.",
  demographic:
    "Voluntary self-identification is never inferred. Answer it yourself or save an explicit default.",
  date_of_birth: "Age and date of birth are never inferred.",
  work_authorization: "Work authorization is answered only by you or from an answer you saved.",
  sponsorship: "Sponsorship needs are answered only by you or from an answer you saved.",
  compensation: "Salary questions are answered only by you or from an answer you saved.",
  availability: "Start date and notice period come only from you or an answer you saved.",
  relocation: "Relocation is answered only by you or from an answer you saved.",
  travel: "Travel willingness is answered only by you or from an answer you saved.",
  criminal_background: "Background questions are answered only by you.",
  conflict_of_interest: "Conflict-of-interest questions are answered only by you.",
  non_compete: "Agreement-related questions are answered only by you.",
  referral: "Referrals are never invented.",
  referral_source: "Only you know how you found the job.",
  unknown: "Career Agent does not recognize this question, so you answer it.",
};

/**
 * Deterministic sensitivity classifier (spec §4.3, §16). Restrictive categories win ties; unknown questions and
 * unknown checkboxes require the owner. A model may later add hints but can never relax this result.
 */
export function classifyQuestion(label: string, type: FieldType): Classification {
  const text = label.replace(/\s+/g, " ").trim();
  let category: QuestionCategory = "unknown";
  for (const [cat, re] of RULES) {
    if (re.test(text)) {
      category = cat;
      break;
    }
  }
  // "Cover letter" as a text box is something to draft; as a file it is an upload.
  if (category === "cover_letter_file" && (type === "textarea" || type === "text"))
    category = "cover_letter_text";
  if (category === "resume_file" && type !== "file") category = "unknown";
  if (
    type === "checkbox" &&
    !["consent_terms", "legal_attestation", "demographic", "captcha"].includes(category)
  ) {
    // Unknown checkboxes may be consent in disguise: never ticked automatically.
    if (BY_CATEGORY[category].decision === "auto_fill" || category === "unknown")
      category = "unknown";
  }
  const base = BY_CATEGORY[category];
  return { category, ...base, reason: REASONS[category] ?? "" };
}
