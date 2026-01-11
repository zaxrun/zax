// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      import: importPlugin,
    },
    rules: {
      // Size limits
      "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 40, skipBlankLines: true, skipComments: true }],
      "complexity": ["error", { max: 12 }],
      "max-params": ["error", { max: 4 }],
      "max-depth": ["error", { max: 3 }],

      // Code quality
      "no-console": "error",
      "no-nested-ternary": "error",
      "curly": "error",
      "eqeqeq": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      "no-useless-return": "error",
      "no-unneeded-ternary": "error",
      "no-lonely-if": "error",
      "no-return-assign": "error",
      "dot-notation": "error",
      "prefer-object-spread": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "prefer-arrow-callback": "error",
      "no-param-reassign": "error",
      "no-duplicate-imports": "error",

      // TypeScript
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/prefer-for-of": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",
      "@typescript-eslint/require-array-sort-compare": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // Import
      "import/no-cycle": "error",
    },
  },
  // Test file overrides
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": "off",
      "max-depth": "off",
      "max-params": "off",
      "complexity": "off",
      "no-console": "off",
      "no-param-reassign": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  // Ignore patterns
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/gen/**",
      "**/*.js",
      "eslint.config.js",
    ],
  }
);
