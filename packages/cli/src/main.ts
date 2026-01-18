import { existsSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { computeWorkspaceId, getCacheDir, ensureCacheDir, getWorkspaceInfo } from "./lib/workspace.js";
import { connectToEngine, getVersion, postCheck } from "./lib/engine-client.js";
import { tryAcquireLock, releaseLock, acquireLockWithTimeout } from "./lib/lock.js";

const SOCKET_WAIT_TIMEOUT_MS = 10000;
const SOCKET_POLL_INTERVAL_MS = 100;

/** Returns true if running as a compiled Bun binary. */
function isCompiledBinary(): boolean {
  // When compiled, execPath is the binary itself, not 'bun' or 'bun.exe'
  const execName = process.execPath.toLowerCase();
  return !execName.endsWith("bun") && !execName.endsWith("bun.exe");
}

function printUsage(): void {
  console.log("Usage: zx [options] [command]");
  console.log("");
  console.log("Commands:");
  console.log("  check            Run tests and show delta");
  console.log("");
  console.log("Options:");
  console.log("  -v, --version    Print version");
  console.log("  -h, --help       Print help");
  console.log("  --deopt          Disable affected test selection (run all tests)");
}

function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

interface CheckResult {
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
}

export function formatCheckOutput(result: CheckResult): string {
  const failurePart = `${result.new_test_failures} new failures, ${result.fixed_test_failures} fixed`;
  const findingPart = `${result.new_findings} new findings, ${result.fixed_findings} fixed`;
  return `${failurePart} | ${findingPart}`;
}

export function computeExitCode(result: CheckResult): number {
  return (result.new_test_failures > 0 || result.new_findings > 0) ? 1 : 0;
}

/** Formats skip message for ESLint. Returns undefined if not skipped. */
export function formatSkipMessage(result: CheckResult): string | undefined {
  if (!result.eslint_skipped) { return undefined; }
  return `eslint: skipped (${result.eslint_skip_reason ?? "unknown"})`;
}

/** Formats affected summary line. Returns undefined if deopt mode. */
export function formatAffectedSummary(result: CheckResult, deopt: boolean): string | undefined {
  if (deopt) { return undefined; }
  return `\u0394 ${result.dirty_count} files changed \u2192 ${result.affected_count} tests affected`;
}

/** Formats completion summary with skipped count. */
export function formatCompletionSummary(
  result: CheckResult,
  deopt: boolean,
  durationSecs: number
): string {
  const passCount = result.new_test_failures === 0 ? "all" : "some";
  const base = `${passCount} tests passed in ${durationSecs.toFixed(1)}s`;
  if (deopt || result.vitest_skipped) { return base; }
  return `${base} (skipped ${result.skipped_count} unaffected)`;
}

/** Gets Engine path - binary in same dir when compiled, source file otherwise. */
function getEnginePath(): string {
  if (isCompiledBinary()) {
    const binDir = dirname(process.execPath);
    return join(binDir, "zx-engine");
  }
  const thisFile = new URL(import.meta.url).pathname;
  const srcDir = resolve(thisFile, "..");
  const repoRoot = resolve(srcDir, "../../..");
  return join(repoRoot, "packages/engine/src/main.ts");
}

async function waitForSocket(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + SOCKET_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
  }

  return false;
}

async function spawnEngine(cacheDir: string, workspaceRoot: string): Promise<void> {
  const enginePath = getEnginePath();

  if (isCompiledBinary() && !existsSync(enginePath)) {
    throw new Error(`Engine binary not found: ${enginePath}`);
  }

  const cmd = isCompiledBinary()
    ? [enginePath, cacheDir, workspaceRoot]
    : ["bun", "run", enginePath, cacheDir, workspaceRoot];

  Bun.spawn(cmd, {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function ensureEngine(cacheDir: string, workspaceRoot: string): Promise<string> {
  const socketPath = join(cacheDir, "zax.sock");
  const lockDir = join(cacheDir, "engine.lock");

  await acquireLockWithTimeout(lockDir);

  try {
    if (existsSync(socketPath)) {
      try {
        await connectToEngine(socketPath);
        return socketPath;
      } catch {
        unlinkSync(socketPath);
      }
    }

    await spawnEngine(cacheDir, workspaceRoot);

    const found = await waitForSocket(socketPath);
    if (!found) {
      throw new Error("Engine failed to start");
    }

    return socketPath;
  } finally {
    releaseLock(lockDir);
  }
}

async function handleVersion(cacheDir: string, cwd: string): Promise<void> {
  try {
    const socketPath = await ensureEngine(cacheDir, cwd);
    const version = await getVersion(socketPath);
    console.log(`zax ${version}`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("connection")) {
      printError("Engine connection failed");
    } else {
      printError(message);
    }
    process.exit(1);
  }
}

async function handleCheck(
  cacheDir: string,
  workspaceId: string,
  workspaceRoot: string,
  packageScope: string | null,
  deopt: boolean
): Promise<void> {
  try {
    const startTime = Date.now();
    const socketPath = await ensureEngine(cacheDir, workspaceRoot);
    const result = await postCheck({ socketPath, workspaceId, workspaceRoot, packageScope, deopt });
    const durationSecs = (Date.now() - startTime) / 1000;

    // Display affected summary (before test output)
    const affectedMsg = formatAffectedSummary(result, deopt);
    if (affectedMsg) { console.log(affectedMsg); }

    const skipMsg = formatSkipMessage(result);
    if (skipMsg) { console.log(skipMsg); }

    if (result.vitest_skipped) {
      console.log("No tests affected, skipping vitest");
    }

    console.log(formatCheckOutput(result));
    console.log(formatCompletionSummary(result, deopt, durationSecs));
    process.exit(computeExitCode(result));
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  // Detect workspace root and package scope
  const { workspaceRoot, packageScope } = getWorkspaceInfo(cwd);

  // Compute workspace ID from the detected root (not cwd)
  const workspaceId = computeWorkspaceId(workspaceRoot);
  const cacheDir = getCacheDir(workspaceId);

  try {
    ensureCacheDir(cacheDir);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const arg = args[0];

  if (arg === "--version" || arg === "-v") {
    await handleVersion(cacheDir, workspaceRoot);
    return;
  }

  if (arg === "--help" || arg === "-h") {
    printUsage();
    process.exit(0);
  }

  if (arg === "check") {
    const deopt = args.includes("--deopt");
    await handleCheck(cacheDir, workspaceId, workspaceRoot, packageScope, deopt);
    return;
  }

  printError(`Unknown option: ${arg}`);
  process.exit(1);
}

// Re-export lock functions for tests
export { tryAcquireLock, releaseLock } from "./lib/lock.js";

// Only run when executed directly, not when imported as a module
if (import.meta.main) {
  main();
}
