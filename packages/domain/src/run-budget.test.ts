import { describe, expect, it } from "vitest";
import { BudgetExceededError } from "./errors.js";
import { RunBudget } from "./run-budget.js";
import type { RunLimits } from "./schemas/run.js";

const limits: RunLimits = {
  deadlineMs: 1000,
  maxModelTurns: 2,
  maxToolCalls: 3,
  maxBrowserSteps: 1,
  maxRetries: 1,
  maxInputChars: 10,
  maxOutputTokens: 100,
  maxCostUsd: 0.5,
};

describe("RunBudget", () => {
  it("throws and aborts when a counter exceeds its limit", () => {
    const b = new RunBudget(limits);
    b.use("modelTurns");
    b.use("modelTurns");
    expect(() => {
      b.use("modelTurns");
    }).toThrow(BudgetExceededError);
    expect(b.signal.aborted).toBe(true);
    expect(() => {
      b.use("toolCalls");
    }).toThrow(/aborted/);
  });

  it("enforces the cost budget", () => {
    const b = new RunBudget(limits);
    b.addCost(0.3);
    expect(() => {
      b.addCost(0.3);
    }).toThrow(/maxCostUsd/);
  });

  it("enforces the deadline", () => {
    let t = 0;
    const b = new RunBudget(limits, undefined, () => t);
    t = 1001;
    expect(() => {
      b.checkAlive();
    }).toThrow(/deadlineMs/);
  });

  it("enforces input size", () => {
    expect(() => {
      new RunBudget(limits).checkInput("x".repeat(11));
    }).toThrow(/maxInputChars/);
  });

  it("follows a parent abort signal", () => {
    const parent = new AbortController();
    const b = new RunBudget(limits, parent.signal);
    parent.abort();
    expect(() => {
      b.checkAlive();
    }).toThrow(/aborted/);
  });
});
