import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against workspace sources, not built dist output.
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
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "scripts/__tests__/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.ts"],
    environment: "node",
    // Default tests must not depend on live services; see CLAUDE.md.
    passWithNoTests: false,
  },
});
