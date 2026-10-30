// Deterministic submission (ADR-007, ADR-033). Exported only through "@career-agent/browser/submission";
// model-facing code (packages/ai, the toolbox, preparation) is forbidden from importing it by ESLint.
export * from "./service.js";
export { submitControlIdentity } from "../adapters/index.js";
export { gateFor, type WriteGate } from "./gate.js";
