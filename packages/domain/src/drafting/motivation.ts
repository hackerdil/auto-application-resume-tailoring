import { numbersIn } from "../tailoring/validator.js";
import { tokens } from "../matching/text.js";
import type { VerifierFinding } from "../schemas/resume.js";

/** Words a motivation sentence may use without them appearing in the posting. */
const MOTIVATION_WORDS = new Set(
  // Normalized with the same tokenizer as the text it is compared with (plural stripping, aliases).
  tokens(
    "interested interest interesting excited exciting keen eager motivated appeal appeals appealing align aligns aligned " +
      "opportunity contribute contributing learn learning mission team work working role position company focus problem " +
      "challenge impact help helping join joining build building apply applying grow growth bring would like want believe " +
      "value values goal goals particularly especially chance part approach product products people culture am me my " +
      "because about how what why which this that these those where when while also very really",
  ),
);

/** Personal-history, referral, or product-use claims and inflated enthusiasm that must come from the owner, not a model. */
const PERSONAL_CLAIMS =
  /\b(i(['’]ve| have) (used|been using|followed|admired|been a)|as a (long-?time |loyal |happy )?(customer|user|fan|subscriber)|referred|my (friend|colleague|former colleague|manager)|i (met|spoke|talked) (with|to)|passionate|always dreamed|dream job|lifelong|since (i was|childhood)|love\b|perfect fit|ideal candidate)\b/i;

/**
 * Validates a motivation sentence (spec §9 Application Drafter): it may only reflect what the posting says, with
 * no new numbers, names, tools, personal history, referrals, or product use, and no claims of fit.
 */
export function validateMotivation(text: string, postingText: string): VerifierFinding[] {
  const findings: VerifierFinding[] = [];
  const crit = (kind: VerifierFinding["kind"], detail: string): VerifierFinding => ({
    severity: "critical",
    kind,
    detail,
  });
  if (PERSONAL_CLAIMS.test(text))
    findings.push(
      crit(
        "other",
        "Motivation claims personal history, product use, a referral, or fit that only you can state.",
      ),
    );
  const posting = numbersIn(postingText);
  const extraNumbers = [...numbersIn(text)].filter((n) => !posting.has(n));
  if (extraNumbers.length)
    findings.push(
      crit("unsupported_number", `Numbers not in the posting: ${extraNumbers.join(", ")}.`),
    );
  const postingTokens = new Set(tokens(postingText));
  const extra = [...new Set(tokens(text))].filter(
    (t) => !postingTokens.has(t) && !MOTIVATION_WORDS.has(t),
  );
  if (extra.length)
    findings.push(
      crit(
        "unsupported_entity",
        `Terms that are neither in the posting nor neutral motivation wording: ${extra.join(", ")}.`,
      ),
    );
  return findings;
}
