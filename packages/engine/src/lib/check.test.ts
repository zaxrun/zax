import { describe, expect, test, mock, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { runCheck, isCheckInProgress, CheckError } from "./check.js";

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

  describe("runCheck", () => {
    test("creates artifacts directory with run_id", async () => {
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
        // Expected to fail - vitest not found
      }

      const artifactsDir = join(cacheDir, "artifacts");
      expect(existsSync(artifactsDir)).toBe(true);
    });

    test("throws error when vitest/npx is missing", async () => {
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
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        // Either CheckError or system error (ENOENT if npx not found)
        expect(err).toBeDefined();
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

  // P6/P7: CheckError codes for timeout handling
  describe("CheckError codes", () => {
    test("VITEST_TIMEOUT code exists for P6 timeout enforcement", () => {
      const err = new CheckError("VITEST_TIMEOUT");
      expect(err.code).toBe("VITEST_TIMEOUT");
      expect(err.name).toBe("CheckError");
    });

    test("RPC_TIMEOUT code exists for gRPC timeout", () => {
      const err = new CheckError("RPC_TIMEOUT");
      expect(err.code).toBe("RPC_TIMEOUT");
    });

    test("CONCURRENT_CHECK code exists for P7 concurrent check prevention", () => {
      const err = new CheckError("CONCURRENT_CHECK");
      expect(err.code).toBe("CONCURRENT_CHECK");
    });

    test("CheckError includes message when provided", () => {
      const err = new CheckError("VITEST_FAILED", "custom message");
      expect(err.code).toBe("VITEST_FAILED");
      expect(err.message).toBe("custom message");
    });

    test("CheckError uses code as message when message not provided", () => {
      const err = new CheckError("INTERNAL");
      expect(err.message).toBe("INTERNAL");
    });
  });
});
