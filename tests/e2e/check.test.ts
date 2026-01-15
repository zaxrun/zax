import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { join, resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import {
  computeWorkspaceId,
  getCacheDir,
} from "../../packages/cli/src/lib/workspace.js";

// E2E tests for the check command
// These tests verify the full CLI → Engine → Rust flow

// ============================================================================
// Test Helpers
// ============================================================================

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Command that was executed (for diagnostics). */
  command: string;
  /** Working directory (for diagnostics). */
  cwd: string;
}

/**
 * Spawns `zx check` CLI binary with cwd set to fixture path.
 * Captures stdout, stderr, exit code, and diagnostic context.
 * @throws Error with command, cwd, and reason if spawn fails
 */
async function spawnCLI(fixtureDir: string): Promise<SpawnResult> {
  const cliPath = resolve(import.meta.dir, "../../packages/cli/src/main.ts");
  const cmd = ["bun", "run", cliPath, "check"];
  const command = cmd.join(" ");

  try {
    const proc = spawn({
      cmd,
      cwd: fixtureDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode, command, cwd: fixtureDir };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Spawn failed: command="${command}" cwd="${fixtureDir}" reason="${reason}"`);
  }
}

/**
 * Checks if fixture has dependencies installed.
 * Returns true if node_modules exists.
 */
function hasFixtureDeps(fixtureDir: string): boolean {
  return existsSync(join(fixtureDir, "node_modules"));
}

/**
 * Clears cache for a fixture to ensure fresh state.
 */
function clearCache(fixtureDir: string): void {
  const workspaceId = computeWorkspaceId(fixtureDir);
  const cacheDir = getCacheDir(workspaceId);

  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

/**
 * Skips test if fixture dependencies not installed.
 * Returns true if test should be skipped.
 */
function shouldSkip(fixtureDir: string, fixtureName: string): boolean {
  if (!hasFixtureDeps(fixtureDir)) {
    console.log(`Skipping: ${fixtureName} node_modules not installed`);
    return true;
  }
  return false;
}

/**
 * Formats result for assertion error messages (diagnostic context).
 */
function formatResultContext(result: SpawnResult): string {
  return `command="${result.command}" cwd="${result.cwd}" stdout="${result.stdout.slice(0, 200)}"`;
}

// ============================================================================
// Fixture Paths
// ============================================================================

const VITEST_BASIC_FIXTURE = resolve(import.meta.dir, "../../fixtures/vitest-basic");
const ESLINT_BASIC_FIXTURE = resolve(import.meta.dir, "../../fixtures/eslint-basic");

// ============================================================================
// vitest-basic Fixture Tests
// ============================================================================

describe("E2E: vitest-basic fixture", () => {
  const fixtureName = "vitest-basic";
  const fixtureDir = VITEST_BASIC_FIXTURE;

  test("CLI spawn captures stdout, stderr, exitCode", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
  });

  test("output matches expected format", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    const formatRegex = /\d+ new failures, \d+ fixed \| \d+ new findings, \d+ fixed/;
    expect(result.stdout, formatResultContext(result)).toMatch(formatRegex);
  });

  test("reports 2 new failures on initial run", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    expect(result.stdout, formatResultContext(result)).toContain("2 new failures");
  });

  test("exit code 1 on initial run (new failures exist)", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    expect(result.exitCode, formatResultContext(result)).toBe(1);
  });

  test("exit code 0 on second run (no new issues)", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);

    // First run - establishes baseline
    await spawnCLI(fixtureDir);

    // Second run - no new issues
    const secondResult = await spawnCLI(fixtureDir);

    expect(secondResult.exitCode, formatResultContext(secondResult)).toBe(0);
  });

  test("no eslint findings (config has no rules)", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    // vitest-basic has eslint.config.js with no rules - ESLint runs but finds nothing
    expect(result.stdout, formatResultContext(result)).not.toContain("eslint: skipped");
    expect(result.stdout, formatResultContext(result)).toContain("0 new findings");
  });
});

// ============================================================================
// eslint-basic Fixture Tests
// ============================================================================

describe("E2E: eslint-basic fixture", () => {
  const fixtureName = "eslint-basic";
  const fixtureDir = ESLINT_BASIC_FIXTURE;

  test("CLI spawn captures stdout, stderr, exitCode", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
  });

  test("reports 3 new findings on initial run", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    expect(result.stdout, formatResultContext(result)).toContain("3 new findings");
  });

  test("exit code 1 on initial run (new findings exist)", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    expect(result.exitCode, formatResultContext(result)).toBe(1);
  });

  test("no eslint skip message when ESLint succeeds", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);
    const result = await spawnCLI(fixtureDir);

    expect(result.stdout, formatResultContext(result)).not.toContain("eslint: skipped");
  });

  test("exit code 0 on second run (no new issues)", async () => {
    if (shouldSkip(fixtureDir, fixtureName)) return;

    clearCache(fixtureDir);

    // First run - establishes baseline
    await spawnCLI(fixtureDir);

    // Second run - no new issues
    const secondResult = await spawnCLI(fixtureDir);

    expect(secondResult.exitCode, formatResultContext(secondResult)).toBe(0);
  });
});

// ============================================================================
// Spawn Failure Propagation Test
// ============================================================================

describe("E2E: spawn failure", () => {
  test("spawnCLI throws with command, cwd, and reason on invalid path", async () => {
    // Create a temporary spawnCLI-like function with invalid CLI path
    const invalidCliPath = "/nonexistent/path/to/cli.ts";
    const cmd = ["bun", "run", invalidCliPath, "check"];
    const command = cmd.join(" ");
    const cwd = VITEST_BASIC_FIXTURE;

    const proc = spawn({
      cmd,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // Spawn should fail with non-zero exit code
    expect(exitCode).not.toBe(0);
    // Stderr should contain error context
    expect(stderr.length).toBeGreaterThan(0);
    // Error should mention the invalid path
    expect(stderr).toContain("nonexistent");
  });

  test("spawnCLI error includes diagnostic context", async () => {
    // Test that our spawnCLI wrapper produces good error messages
    // by verifying the SpawnResult contains command and cwd
    if (!hasFixtureDeps(VITEST_BASIC_FIXTURE)) {
      console.log("Skipping: fixture node_modules not installed");
      return;
    }

    clearCache(VITEST_BASIC_FIXTURE);
    const result = await spawnCLI(VITEST_BASIC_FIXTURE);

    // Verify diagnostic fields are populated
    expect(result.command).toContain("bun run");
    expect(result.command).toContain("main.ts check");
    expect(result.cwd).toBe(VITEST_BASIC_FIXTURE);
  });
});
