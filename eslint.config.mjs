import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "artifacts/**",
    "build/**",
    "coverage/**",
    "dist/**",
    "dist-ssr/**",
    "models/**",
    "node_modules/**",
    "out/**",
    "release/**",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      eslintConfigPrettier,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // TypeScript already enforces these compiler-level checks.
      "@typescript-eslint/no-unused-vars": "off",
      // Windows file-name sanitizers intentionally reject control characters.
      "no-control-regex": "off",
      // Existing async loading effects initialize local UI state.
      "react-hooks/set-state-in-effect": "off",
    },
  },
);
