import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PORTS, startDemo } from "../scripts/demo.mjs";

// End-to-end through the real web app, API, and worker in the fictional demo (dry-run, no AI, local forms only).
// Needs `pnpm build` first; uses the demo ports, so stop any local Career Agent instance before running.

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer()
      .once("error", () => {
        resolve(false);
      })
      .once("listening", () => {
        s.close(() => {
          resolve(true);
        });
      })
      .listen(port, "127.0.0.1");
  });

let demo: Awaited<ReturnType<typeof startDemo>>;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  for (const p of Object.values(DEMO_PORTS))
    if (!(await portFree(p)))
      throw new Error(`Port ${String(p)} is in use; stop the local app before running E2E.`);
  demo = await startDemo({
    dataDir: mkdtempSync(path.join(tmpdir(), "ca-e2e-")),
    headless: true,
    quiet: true,
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  page = await (await browser.newContext()).newPage();
}, 120_000);

afterAll(async () => {
  await browser.close();
  await demo.stop();
});

/** Serious and critical accessibility problems on the current page (WCAG 2.1 A/AA rules). */
async function a11y(p: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: p })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id}: ${v.help} (${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 3)
          .join(", ")})`,
    );
}

describe("demo end to end", () => {
  it("every main page loads in demo mode and passes the accessibility check", async () => {
    const problems: string[] = [];
    for (const route of [
      "/",
      "/jobs",
      "/applications",
      "/sources",
      "/facts",
      "/profile",
      "/usage",
    ]) {
      await page.goto(`${demo.url}${route}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.getByText("Demo mode:").waitFor();
      problems.push(...(await a11y(page)).map((p) => `${route} ${p}`));
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("goes from a fictional job to a filled form ready for review, and cannot be submitted", async () => {
    await page.goto(`${demo.url}/jobs`);
    await page
      .getByRole("link", { name: /Senior Backend Engineer/ })
      .first()
      .click();
    await page.getByRole("heading", { name: "Senior Backend Engineer" }).waitFor();

    // Tailor a résumé from the fictional facts (rule-based in the demo) and approve it.
    await page.getByRole("button", { name: "Tailor a résumé" }).click();
    await page
      .getByRole("link", { name: /one-page/ })
      .first()
      .click({ timeout: 90_000 });
    await page.getByRole("button", { name: "Approve this résumé" }).click();
    await page.getByText("Approved.").waitFor();
    expect(await a11y(page)).toEqual([]);

    // Start the application, choose the résumé, and skip the cover letter.
    await page.goBack();
    await page.getByRole("heading", { name: "Senior Backend Engineer" }).waitFor();
    await page.getByRole("button", { name: "Start an application" }).click();
    await page.getByRole("heading", { name: /Senior Backend Engineer/ }).waitFor();
    // Controlled inputs: checked once the server has saved the choice.
    for (const box of [
      page.getByRole("radio", { name: /Résumé from/ }).first(),
      page.getByRole("checkbox", { name: "Apply without a cover letter" }),
    ]) {
      await box.click();
      await expect.poll(() => box.isChecked(), { timeout: 10_000 }).toBe(true);
    }

    // The worker opens the fictional form (headless here), fills what it can, and waits for the owner.
    await page.getByRole("button", { name: "Prepare in browser" }).click();
    await page.getByText("Waiting for you", { exact: true }).waitFor({ timeout: 90_000 });
    for (const [question, value] of [
      [/legally authorized to work/, "Yes"],
      [/require sponsorship/, "No"],
    ] as const) {
      const card = page.getByRole("article", { name: question });
      await card.getByLabel("Your answer").selectOption(value);
      await card.getByRole("button", { name: "Save answer" }).click();
      await card.getByText(value).first().waitFor();
    }
    expect(await a11y(page)).toEqual([]);

    // Continue: the form is filled; consent stays with the owner, and the demo can never approve.
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Form filled — ready for your review").waitFor({ timeout: 90_000 });
    await page
      .getByText(/You complete: "I agree to the privacy policy/)
      .first()
      .waitFor();
    await expect(
      page.getByRole("button", { name: "Approve and submit" }).isDisabled(),
    ).resolves.toBe(true);
    expect(await a11y(page)).toEqual([]);
  }, 300_000);
});
