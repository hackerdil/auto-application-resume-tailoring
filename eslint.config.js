// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "coverage/**", "data/**", "artifacts/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "*.js",
            "*.mjs",
            "scripts/*.mjs",
            ".claude/hooks/*.mjs",
            "packages/db/drizzle.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "off",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // ADR-007: model-facing code must never reach the deterministic submission service. policy.ts is the one
    // exception in the browser package: it creates each context's (closed) write gate.
    files: [
      "packages/ai/**/*.ts",
      "packages/browser/src/tools/**/*.ts",
      "packages/browser/src/toolbox.ts",
      "packages/browser/src/preparation/**/*.ts",
      "packages/browser/src/adapters/**/*.ts",
      "packages/browser/src/{controls,snapshot,session,collector}.ts",
      "apps/worker/src/preparer.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@career-agent/browser/submission", "**/submission", "**/submission/**"],
              message: "Model-accessible code must not import the submission service (ADR-007).",
            },
          ],
        },
      ],
    },
  },
);
