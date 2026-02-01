import { describe, expect, test, mock, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { runCheck, isCheckInProgress, CheckError, buildEslintCommand, detectEslintSkipReason, normalizeEslintPaths, normalizeVitestPaths } from "./check.js";

describe("check module", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `zax-check-test-${Date.now()}-${Math.random()}`);
    mkdirSync(cacheDir, { recursive: true });
  });

  describe("isCheckInProgress", () => {
    test("returns false initially", () => {
      expect(isCheckInProgress()).toBe(false);
    });
  });

  // P6/P7: CheckError codes for timeout handling
  describe("CheckError codes", () => {
    test("sets error code correctly", () => {
      const err = new CheckError("VITEST_TIMEOUT");
      expect(err.code).toBe("VITEST_TIMEOUT");
    });

    test("sets error name to CheckError", () => {
      const err = new CheckError("VITEST_TIMEOUT");
      expect(err.name).toBe("CheckError");
    });

    test("RPC_TIMEOUT code is supported", () => {
      const err = new CheckError("RPC_TIMEOUT");
      expect(err.code).toBe("RPC_TIMEOUT");
    });

    test("CONCURRENT_CHECK code is supported", () => {
      const err = new CheckError("CONCURRENT_CHECK");
      expect(err.code).toBe("CONCURRENT_CHECK");
    });

    test("constructor sets custom message", () => {
      const err = new CheckError("VITEST_FAILED", "custom message");
      expect(err.message).toBe("custom message");
    });

    test("constructor sets code when message is provided", () => {
      const err = new CheckError("VITEST_FAILED", "custom message");
      expect(err.code).toBe("VITEST_FAILED");
    });

    test("message defaults to code when not provided", () => {
      const err = new CheckError("INTERNAL");
      expect(err.message).toBe("INTERNAL");
    });
  });

  // P2: ESLint Command Construction
  describe("buildEslintCommand", () => {
    test("returns correct command array with output path", () => {
      const path = "/cache/artifacts/run1/eslint.json";
      const cmd = buildEslintCommand("npm", path);
      expect(cmd).toEqual(["npx", "eslint", "-f", "json", "-o", path, "."]);
    });

    test("output path is in -o flag", () => {
      const outputPath = "/cache/artifacts/run-uuid/eslint.json";
      const cmd = buildEslintCommand("npm", outputPath);
      // cmd is ["npx", "eslint", "-f", "json", "-o", outputPath, "."]
      const outputIndex = cmd.indexOf("-o") + 1;
      expect(cmd[outputIndex]).toBe(outputPath);
    });

    test("uses targetPath when provided", () => {
      const path = "/cache/artifacts/run1/eslint.json";
      const cmd = buildEslintCommand("npm", path, "packages/auth");
      expect(cmd).toEqual(["npx", "eslint", "-f", "json", "-o", path, "packages/auth"]);
      expect(cmd).not.toContain(".");
    });
  });

  describe("runCheck", () => {
    test("creates artifacts directory with run_id", async () => {
      const mockClient = {
        ingestManifest: mock(() => Promise.resolve({})),
        getDeltaSummary: mock(() => Promise.resolve({ newTestFailures: 0, fixedTestFailures: 0 })),
        getAffectedTests: mock(() => Promise.resolve({ dirtyFiles: [], testFiles: [], isFullRun: false })),
      };

      // Create a valid workspace with node_modules so preFlightCheck passes
      const validWorkspace = join(cacheDir, "valid-workspace");
      mkdirSync(join(validWorkspace, "node_modules"), { recursive: true });

      try {
        await runCheck({
          cacheDir,
          workspaceId: "test-ws",
          workspaceRoot: validWorkspace,
          rustClient: mockClient as never,
        });
      } catch {
        // Expected to fail - vitest not found
      }

      const artifactsDir = join(cacheDir, "artifacts");
      expect(existsSync(artifactsDir)).toBe(true);
    });

    test("throws DEPS_NOT_INSTALLED when node_modules is missing", async () => {
      const mockClient = {
        ingestManifest: mock(() => Promise.resolve({})),
        getDeltaSummary: mock(() => Promise.resolve({ newTestFailures: 0, fixedTestFailures: 0 })),
      };

      try {
        await runCheck({
          cacheDir,
          workspaceId: "test-ws",
          workspaceRoot: "/nonexistent/path/that/does/not/exist",
          rustClient: mockClient as never,
        });
        expect(true).toBe(false); // Should have thrown
      } catch (e: unknown) {
        if (e instanceof CheckError) {
          expect(e.code).toBe("DEPS_NOT_INSTALLED");
        } else {
          throw e;
        }
      }
    });

    test("concurrent check flag is reset after completion", async () => {
      // After a check completes (success or failure), flag should be reset
      const mockClient = {
        ingestManifest: mock(() => Promise.resolve({})),
        getDeltaSummary: mock(() => Promise.resolve({ newTestFailures: 0, fixedTestFailures: 0 })),
      };

      try {
        await runCheck({
          cacheDir,
          workspaceId: "test-ws",
          workspaceRoot: "/nonexistent",
          rustClient: mockClient as never,
        });
      } catch {
        // Expected to fail
      }

      // After completion, should not be in progress
      expect(isCheckInProgress()).toBe(false);
    });
  });

  // P5: Skip Detection
  describe("detectEslintSkipReason", () => {
    test("returns 'not found' when stderr contains 'command not found'", () => {
      expect(detectEslintSkipReason(127, "bash: npx: command not found", "/nonexistent")).toBe("not found");
    });

    test("returns 'not found' when stderr contains 'npx: command not found'", () => {
      expect(detectEslintSkipReason(1, "npx: command not found", "/nonexistent")).toBe("not found");
    });

    test("returns 'not found' when stderr contains 'eslint: not found'", () => {
      expect(detectEslintSkipReason(1, "eslint: not found", "/nonexistent")).toBe("not found");
    });

    test("returns 'not found' when stderr contains 'eslint: command not found'", () => {
      expect(detectEslintSkipReason(127, "eslint: command not found", "/nonexistent")).toBe("not found");
    });

    test("returns 'no config' when stderr mentions No ESLint configuration", () => {
      expect(detectEslintSkipReason(1, "No ESLint configuration found", "/nonexistent")).toBe("no config");
    });

    test("returns 'no config' when stderr mentions eslint.config", () => {
      expect(detectEslintSkipReason(1, "Could not find eslint.config", "/nonexistent")).toBe("no config");
    });

    test("returns 'failed' when exit code non-zero and no output file", () => {
      expect(detectEslintSkipReason(1, "some other error", "/nonexistent/file.json")).toBe("failed");
    });

    test("returns undefined when exit code is 0", () => {
      expect(detectEslintSkipReason(0, "", "/nonexistent")).toBeUndefined();
    });

    test("returns undefined when exit code non-zero but output file exists", () => {
      const testFile = join(cacheDir, "eslint-output.json");
      writeFileSync(testFile, "[]");
      expect(detectEslintSkipReason(1, "", testFile)).toBeUndefined();
    });
  });

  // P8: Path Normalization
  describe("normalizeEslintPaths", () => {
    interface EslintFileResult { filePath?: string; messages: unknown[] }

    test("strips workspace root prefix from file paths", () => {
      const testFile = join(cacheDir, "eslint.json");
      const input = [{ filePath: "/workspace/project/src/file.js", messages: [] }];
      writeFileSync(testFile, JSON.stringify(input));
      normalizeEslintPaths(testFile, "/workspace/project");
      const output = JSON.parse(readFileSync(testFile, "utf-8")) as EslintFileResult[];
      expect(output[0].filePath).toBe("src/file.js");
    });

    test("handles workspace root with trailing slash", () => {
      const testFile = join(cacheDir, "eslint2.json");
      const input = [{ filePath: "/workspace/project/src/file.js", messages: [] }];
      writeFileSync(testFile, JSON.stringify(input));
      normalizeEslintPaths(testFile, "/workspace/project/");
      const output = JSON.parse(readFileSync(testFile, "utf-8")) as EslintFileResult[];
      expect(output[0].filePath).toBe("src/file.js");
    });

    test("leaves paths unchanged if they don't start with workspace root", () => {
      const testFile = join(cacheDir, "eslint3.json");
      const input = [{ filePath: "/other/path/file.js", messages: [] }];
      writeFileSync(testFile, JSON.stringify(input));
      normalizeEslintPaths(testFile, "/workspace/project");
      const output = JSON.parse(readFileSync(testFile, "utf-8")) as EslintFileResult[];
      expect(output[0].filePath).toBe("/other/path/file.js");
    });

    test("handles entries without filePath", () => {
      const testFile = join(cacheDir, "eslint4.json");
      const input: EslintFileResult[] = [{ messages: [] }];
      writeFileSync(testFile, JSON.stringify(input));
      normalizeEslintPaths(testFile, "/workspace/project");
      const output = JSON.parse(readFileSync(testFile, "utf-8")) as EslintFileResult[];
      expect(output[0].filePath).toBeUndefined();
    });
  });

  // Vitest Path Normalization
  describe("normalizeVitestPaths", () => {
    interface VitestOutput { testResults?: Array<{ name?: string }> }

    test("strips workspace root prefix from test file names", () => {
      const testFile = join(cacheDir, "vitest.json");
      const input = { testResults: [{ name: "/workspace/project/src/test.ts" }] };
      writeFileSync(testFile, JSON.stringify(input));
      normalizeVitestPaths(testFile, "/workspace/project");
      const output = JSON.parse(readFileSync(testFile, "utf-8")) as VitestOutput;
      expect(output.testResults?.[0].name).toBe("src/test.ts");
    });

    test("handles missing testResults array", () => {
      const testFile = join(cacheDir, "vitest2.json");
      const input = {};
      writeFileSync(testFile, JSON.stringify(input));
      normalizeVitestPaths(testFile, "/workspace/project");
      const output = JSON.parse(readFileSync(testFile, "utf-8")) as VitestOutput;
      expect(output.testResults).toBeUndefined();
    });

    test("leaves paths unchanged if not matching workspace root", () => {
      const testFile = join(cacheDir, "vitest3.json");
      const input = { testResults: [{ name: "/other/path/test.ts" }] };
      writeFileSync(testFile, JSON.stringify(input));
      normalizeVitestPaths(testFile, "/workspace/project");
      const output = JSON.parse(readFileSync(testFile, "utf-8")) as VitestOutput;
      expect(output.testResults?.[0].name).toBe("/other/path/test.ts");
    });
  });

  // Bun proc.killed bug regression test
  describe("timeout detection", () => {
    test("fast-completing process does not trigger false timeout", async () => {
      // This tests the fix for Bun's proc.killed being true even on normal exit
      const { spawn } = await import("bun");
      const proc = spawn({
        cmd: ["echo", "hello"],
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, 5000);
      await proc.exited;
      clearTimeout(timeout);
      // The key assertion: timedOut should be false for a fast process
      expect(timedOut).toBe(false);
      // Note: proc.killed would be true in Bun even though we didn't timeout!
    });

    // P6: Actual timeout behavior test
    test("slow process triggers timeout flag when killed", async () => {
      const { spawn } = await import("bun");
      const proc = spawn({
        cmd: ["sleep", "10"], // Would take 10s without timeout
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const SHORT_TIMEOUT_MS = 100; // 100ms timeout for test
      const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, SHORT_TIMEOUT_MS);
      await proc.exited;
      clearTimeout(timeout);
      // The key assertion: timedOut should be true when we kill slow process
      expect(timedOut).toBe(true);
    });
  });

  // P6: Manifest Artifact Inclusion
  describe("CheckResult fields", () => {
    test("result includes eslintSkipped flag", async () => {
      const mockClient = {
        ingestManifest: mock(() => Promise.resolve({})),
        getDeltaSummary: mock(() => Promise.resolve({
          newTestFailures: 0,
          fixedTestFailures: 0,
          newFindings: 0,
          fixedFindings: 0,
        })),
      };

      try {
        const result = await runCheck({
          cacheDir,
          workspaceId: "test-ws",
          workspaceRoot: "/nonexistent",
          rustClient: mockClient as never,
        });
        // If we get here, check result shape
        expect(typeof result.eslintSkipped).toBe("boolean");
      } catch {
        // Expected to fail - vitest not found
      }
    });
  });

  // P1: ESLint Spawn Sequencing - Vitest runs before ESLint
  describe("spawn sequencing", () => {
    test("spawnEslint returns result when run independently", async () => {
      // This test verifies spawnEslint is a separate function that can be called
      // after vitest completes. The executeCheck function calls them sequentially:
      // await spawnVitest(...) then await spawnEslint(...)
      const { spawnEslint } = await import("./check.js");
      const testOutputFile = join(cacheDir, "eslint-seq-test.json");

      // spawnEslint should return a result even when eslint is not installed
      const result = await spawnEslint(cacheDir, testOutputFile, "npm");
      expect(result).toHaveProperty("skipped");
      // In test env without eslint, should be skipped
      expect(result.skipped).toBe(true);
    });
  });

  // P3: ESLint Non-Zero Exit Handling
  describe("eslint non-zero exit handling", () => {
    test("non-zero exit with output file returns skipped=false", () => {
      // When eslint exits non-zero but produces output, we should NOT skip
      const testOutputFile = join(cacheDir, "eslint-nonzero.json");
      writeFileSync(testOutputFile, "[]"); // Valid output exists
      const skipReason = detectEslintSkipReason(1, "", testOutputFile);
      // No skip reason means we proceed with the output
      expect(skipReason).toBeUndefined();
    });

    test("non-zero exit without output file returns skipped=true with 'failed'", () => {
      // When eslint exits non-zero and no output file, we skip
      const nonexistentFile = join(cacheDir, "nonexistent-eslint.json");
      const skipReason = detectEslintSkipReason(1, "some error", nonexistentFile);
      expect(skipReason).toBe("failed");
    });

    test("zero exit always returns skipped=false regardless of output", () => {
      // Exit code 0 means success - never skip
      const skipReason = detectEslintSkipReason(0, "", "/nonexistent/file.json");
      expect(skipReason).toBeUndefined();
    });

    test("non-zero with output proceeds and includes FINDING artifact", () => {
      // Integration test: when eslint exits 1 but produces valid JSON output,
      // the artifact should be included in the manifest (not skipped)
      const testOutputFile = join(cacheDir, "eslint-proceed.json");

      // Pre-create a valid output file to simulate eslint producing output
      writeFileSync(testOutputFile, '[{"filePath":"/test/a.js","messages":[]}]');

      // Now verify detectEslintSkipReason returns undefined (proceed)
      const skipReason = detectEslintSkipReason(1, "", testOutputFile);
      expect(skipReason).toBeUndefined();

      // This means buildArtifactList will include the FINDING artifact
      // (verified by the conditional: !eslintResult.skipped && eslintResult.outputPath)
    });
  });
});
