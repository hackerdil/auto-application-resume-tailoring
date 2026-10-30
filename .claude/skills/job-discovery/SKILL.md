---
name: job-discovery
description: Design, implement, or review job-source adapters, normalization, filtering, freshness, and deduplication. Use for discovery work involving approved ATS APIs or manually supplied job URLs.
---

# Job discovery

1. Prefer official/public ATS APIs and deterministic parsing.
2. Do not add LinkedIn/Indeed scraping or bypass access controls.
3. Normalize into the canonical Job schema and retain source URL, fetch time, and content hash.
4. Apply deterministic filters before paid model scoring.
5. Rate-limit per origin, cache responsibly, and isolate source failures.
6. Add fixture-based contract tests for every adapter.
7. Explain unsupported fields; never silently invent normalized values.

References: docs/DECISIONS.md ADR-010, docs/DATA_MODEL.md (Job), docs/THREAT_MODEL.md T10.
