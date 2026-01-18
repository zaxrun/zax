import { describe, expect, test } from "bun:test";
import { formatCheckOutput, computeExitCode, formatSkipMessage } from "./main.js";

/** Creates a CheckResult with default values for required fields. */
function makeResult(partial: Partial<{
  new_test_failures: number;
  fixed_test_failures: number;
  new_findings: number;
  fixed_findings: number;
  eslint_skipped?: boolean;
  eslint_skip_reason?: string;
  affected_count: number;
  skipped_count: number;
  dirty_count: number;
  vitest_skipped: boolean;
}>) {
  return {
    new_test_failures: 0,
    fixed_test_failures: 0,
    new_findings: 0,
    fixed_findings: 0,
    affected_count: 0,
    skipped_count: 0,
    dirty_count: 0,
    vitest_skipped: false,
    ...partial,
  };
}

describe("CLI output formatting", () => {
  // P19: CLI Combined Output Format
  describe("formatCheckOutput", () => {
    test("formats output with test failures and findings", () => {
      const result = makeResult({
        new_test_failures: 2,
        fixed_test_failures: 1,
        new_findings: 3,
        fixed_findings: 0,
      });
      expect(formatCheckOutput(result)).toBe("2 new failures, 1 fixed | 3 new findings, 0 fixed");
    });

    test("formats output with zero counts", () => {
      const result = makeResult({
        new_test_failures: 0,
        fixed_test_failures: 0,
        new_findings: 0,
        fixed_findings: 0,
      });
      expect(formatCheckOutput(result)).toBe("0 new failures, 0 fixed | 0 new findings, 0 fixed");
    });

    test("formats output with only failures", () => {
      const result = makeResult({
        new_test_failures: 5,
        fixed_test_failures: 2,
        new_findings: 0,
        fixed_findings: 0,
      });
      expect(formatCheckOutput(result)).toBe("5 new failures, 2 fixed | 0 new findings, 0 fixed");
    });

    test("formats output with only findings", () => {
      const result = makeResult({
        new_test_failures: 0,
        fixed_test_failures: 0,
        new_findings: 10,
        fixed_findings: 3,
      });
      expect(formatCheckOutput(result)).toBe("0 new failures, 0 fixed | 10 new findings, 3 fixed");
    });
  });

  // P21: Exit Code Logic
  describe("computeExitCode", () => {
    test("returns 0 when no new issues", () => {
      expect(computeExitCode(makeResult({
        new_test_failures: 0,
        fixed_test_failures: 5,
        new_findings: 0,
        fixed_findings: 10,
      }))).toBe(0);
    });

    test("returns 1 when new test failures exist", () => {
      expect(computeExitCode(makeResult({
        new_test_failures: 1,
        fixed_test_failures: 0,
        new_findings: 0,
        fixed_findings: 0,
      }))).toBe(1);
    });

    test("returns 1 when new findings exist", () => {
      expect(computeExitCode(makeResult({
        new_test_failures: 0,
        fixed_test_failures: 0,
        new_findings: 1,
        fixed_findings: 0,
      }))).toBe(1);
    });

    test("returns 1 when both new failures and findings exist", () => {
      expect(computeExitCode(makeResult({
        new_test_failures: 3,
        fixed_test_failures: 1,
        new_findings: 5,
        fixed_findings: 2,
      }))).toBe(1);
    });

    test("returns 0 when only fixed issues exist", () => {
      expect(computeExitCode(makeResult({
        new_test_failures: 0,
        fixed_test_failures: 100,
        new_findings: 0,
        fixed_findings: 50,
      }))).toBe(0);
    });
  });

  // P20: CLI Skip Message
  describe("formatSkipMessage", () => {
    test("returns undefined when not skipped", () => {
      expect(formatSkipMessage(makeResult({
        new_test_failures: 0,
        fixed_test_failures: 0,
        new_findings: 0,
        fixed_findings: 0,
      }))).toBeUndefined();
    });

    test("formats 'not found' skip reason", () => {
      expect(formatSkipMessage(makeResult({
        eslint_skipped: true,
        eslint_skip_reason: "not found",
      }))).toBe("eslint: skipped (not found)");
    });

    test("formats 'no config' skip reason", () => {
      expect(formatSkipMessage(makeResult({
        eslint_skipped: true,
        eslint_skip_reason: "no config",
      }))).toBe("eslint: skipped (no config)");
    });

    test("formats 'timeout' skip reason", () => {
      expect(formatSkipMessage(makeResult({
        eslint_skipped: true,
        eslint_skip_reason: "timeout",
      }))).toBe("eslint: skipped (timeout)");
    });

    test("formats 'failed' skip reason", () => {
      expect(formatSkipMessage(makeResult({
        eslint_skipped: true,
        eslint_skip_reason: "failed",
      }))).toBe("eslint: skipped (failed)");
    });

    test("handles missing skip reason with 'unknown'", () => {
      expect(formatSkipMessage(makeResult({
        eslint_skipped: true,
      }))).toBe("eslint: skipped (unknown)");
    });
  });
});
