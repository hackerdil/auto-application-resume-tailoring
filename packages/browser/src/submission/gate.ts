import type { BrowserContext } from "playwright";

/**
 * One-shot permission for writes during the single approved submit click (ADR-033). Created closed for every
 * context by the route guard; only the submission service (this subpath, which model-facing code may not import)
 * can open it, and only for the bound origin.
 */
export interface WriteGate {
  open: boolean;
  origin: string | null;
  /** Writes that left the browser while the gate was open. */
  sent: { method: string; url: string; at: string }[];
}

const gates = new WeakMap<BrowserContext, WriteGate>();

/** Called by the route guard when it is installed. */
export function createGate(context: BrowserContext): WriteGate {
  const gate: WriteGate = { open: false, origin: null, sent: [] };
  gates.set(context, gate);
  return gate;
}

export function gateFor(context: BrowserContext): WriteGate {
  const gate = gates.get(context);
  if (!gate) throw new Error("This browser context has no route guard.");
  return gate;
}
