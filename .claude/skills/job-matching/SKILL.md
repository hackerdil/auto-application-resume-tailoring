---
name: job-matching
description: Implement or review evidence-backed matching between a verified candidate fact bank and a normalized job. Use for scoring, requirements extraction, filtering, and match explanations.
---

# Job matching

1. Extract requirements with stable IDs and classify required, preferred, inferred, or unknown.
2. Cite verified fact IDs for every claimed match.
3. Apply hard filters deterministically before weighted scoring.
4. Never use protected characteristics.
5. Return per-dimension scores, gaps, unknowns, and evidence—not only a total.
6. Label the score as an internal relevance heuristic, not an ATS or hiring prediction.
7. Validate structured output and test boundary cases.

References: docs/DATA_MODEL.md (MatchResult), docs/PROMPT_SECURITY.md.
