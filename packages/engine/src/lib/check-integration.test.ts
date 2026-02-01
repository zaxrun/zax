import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { runCheck, CheckError } from "./check.js";

describe("check integration", () => {
  let cacheDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `zax-check-int-cache-${Date.now()}-${Math.random()}`);
    workspaceRoot = join(tmpdir(), `zax-check-int-ws-${Date.now()}-${Math.random()}`);
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("Property C2: Pre-Flight Check Execution - throws DEPS_NOT_INSTALLED when node_modules missing", async () => {
    // Setup: No node_modules in workspaceRoot
    // We need a lockfile so it detects a PM, otherwise it defaults to npm
    writeFileSync(join(workspaceRoot, "package-lock.json"), "{}");

    const mockClient = {
      ingestManifest: mock(() => Promise.resolve({})),
      getDeltaSummary: mock(() => Promise.resolve({ newTestFailures: 0, fixedTestFailures: 0 })),
      getAffectedTests: mock(() => Promise.resolve({ dirtyFiles: [], testFiles: [], isFullRun: false })),
    };

    try {
      await runCheck({
        cacheDir,
        workspaceId: "test-ws",
        workspaceRoot,
        rustClient: mockClient as never,
      });
      expect(true).toBe(false); // Should not reach here
    } catch (e: unknown) {
      if (e instanceof CheckError) {
        expect(e.code).toBe("DEPS_NOT_INSTALLED");
        expect(e.message).toContain("npm install");
      } else {
        throw e;
      }
    }
  });
});
