#!/usr/bin/env node
// Placeholder for scripts whose implementation lands in a later phase.
// Exits non-zero so nothing can mistake a placeholder for a passing step.
const [, , name = "command", phase = "?"] = process.argv;
console.error(
  `"${name}" is not implemented yet; it arrives in Phase ${phase} (docs/IMPLEMENTATION_PLAN.md).`,
);
process.exit(1);
