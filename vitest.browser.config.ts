import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Browser tests (ADR-030): Playwright library + headless Chromium against local fictional fixture forms served
 * on 127.0.0.1. Never a real employer site.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@career-agent\/([a-z-]+)\/([a-z-]+)$/,
        replacement: `${root}packages/$1/src/$2/index.ts`,
      },
      { find: /^@career-agent\/([a-z-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
    ],
  },
  test: {
    include: [
      "packages/*/src/**/*.browser.test.ts",
      "apps/*/src/**/*.browser.test.ts",
      "e2e/**/*.browser.test.ts",
    ],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    passWithNoTests: false,
  },
});
