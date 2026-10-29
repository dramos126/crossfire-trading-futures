import nextConfig from "eslint-config-next";
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...nextConfig,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      // Catch unused locals/params that tsc misses without strict flags
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          vars: "all",
          args: "after-used",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      // Prefer const
      "prefer-const": "warn",
      // No implicit any beyond what tsconfig strict already catches
      "@typescript-eslint/no-explicit-any": "warn",
      // Floating promises are a common async bug vector
      "@typescript-eslint/no-floating-promises": "warn",
      // no-console keeps debug logs from leaking to prod
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Scripts and config files don't need strict project-typed linting
    files: ["scripts/**/*.mjs", "*.config.*"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
