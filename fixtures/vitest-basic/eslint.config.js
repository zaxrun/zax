// This config exists to prevent ESLint from finding configs in parent directories.
// It lints all JS/TS files but has no rules enabled, so produces no findings.
// Used for E2E testing to verify the "no skip message" and "0 findings" paths.
export default [
  {
    files: ["**/*.{js,ts,jsx,tsx}"],
    rules: {},
  },
];
