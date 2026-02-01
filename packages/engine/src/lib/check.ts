import { spawn } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type RustClient, getAffectedTests } from "./rust-client.js";
import { log } from "./logger.js";
import { normalizeEslintPaths, normalizeVitestPaths } from "./normalize.js";
import { ingestArtifacts, callGetDeltaSummary } from "./rpc-calls.js";
import { CheckError, type CheckErrorCode } from "./errors.js";
import {
  detectPackageManager,
  preFlightCheck,
  buildVitestCommand,
  buildEslintCommand,
  type PackageManager
} from "./pkg-manager.js";

const VITEST_TIMEOUT_MS = 300_000;
const ESLINT_TIMEOUT_MS = 300_000;

export { CheckError, type CheckErrorCode };

export interface CheckOptions {
  cacheDir: string;
  workspaceId: string;
  workspaceRoot: string;
  rustClient: RustClient;
  deopt?: boolean;
  packageScope?: string;
}

export interface CheckResult {
  newTestFailures: number;
  fixedTestFailures: number;
  newFindings: number;
  fixedFindings: number;
  eslintSkipped: boolean;
  eslintSkipReason?: string;
  affectedCount: number;
  skippedCount: number;
  dirtyCount: number;
  vitestSkipped: boolean;
}


export type EslintSkipReason = "not found" | "no config" | "failed" | "timeout";

interface EslintResult { skipped: boolean; skipReason?: EslintSkipReason; outputPath?: string; }

let checkInProgress = false;
export function isCheckInProgress(): boolean { return checkInProgress; }

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  if (checkInProgress) { throw new CheckError("CONCURRENT_CHECK"); }
  checkInProgress = true;
  try { return await executeCheck(options); } finally { checkInProgress = false; }
}

interface VitestRunResult { skipped: boolean; skippedCount: number; }

async function runVitest(
  workspaceRoot: string,
  vitestPath: string,
  pm: PackageManager,
  affected: { isFullRun: boolean; testFiles: string[] }
): Promise<VitestRunResult> {
  if (affected.isFullRun) {
    await spawnVitest(workspaceRoot, vitestPath, pm);
    return { skipped: false, skippedCount: 0 };
  }
  if (affected.testFiles.length > 0) {
    await spawnVitest(workspaceRoot, vitestPath, pm, affected.testFiles);
    return { skipped: false, skippedCount: 0 };
  }
  log("No tests affected, skipping vitest");
  return { skipped: true, skippedCount: 0 };
}

async function executeCheck(options: CheckOptions): Promise<CheckResult> {
  const { cacheDir, workspaceId, workspaceRoot, rustClient, deopt, packageScope } = options;
  const pm = detectPackageManager(workspaceRoot);
  preFlightCheck(workspaceRoot, pm);

  const runId = crypto.randomUUID();
  const artifactsDir = join(cacheDir, "artifacts", runId);
  mkdirSync(artifactsDir, { recursive: true });

  const forceFull = deopt ?? false;
  const scope = packageScope ?? "";
  const affected = await getAffectedTests(rustClient, workspaceId, forceFull, scope);
  const dirtyCount = affected.dirtyFiles.length;
  const affectedCount = affected.testFiles.length;
  log(`Affected: dirty=${dirtyCount}, tests=${affectedCount}, full_run=${affected.isFullRun}`);

  const vitestPath = join(artifactsDir, "vitest.json");
  const vitestRes = await runVitest(workspaceRoot, vitestPath, pm, affected);
  if (existsSync(vitestPath)) { normalizeVitestPaths(vitestPath, workspaceRoot); }

  const eslintTarget = scope || undefined;
  const eslintResult = await spawnEslint(workspaceRoot, join(artifactsDir, "eslint.json"), pm, eslintTarget);
  if (!eslintResult.skipped && eslintResult.outputPath) { normalizeEslintPaths(eslintResult.outputPath, workspaceRoot); }

  await ingestArtifacts(rustClient, { workspaceId, runId, vitestPath, eslintResult, packageScope: scope });
  const delta = await callGetDeltaSummary(rustClient, workspaceId, scope);
  return {
    ...delta,
    eslintSkipped: eslintResult.skipped,
    eslintSkipReason: eslintResult.skipReason,
    affectedCount,
    skippedCount: vitestRes.skippedCount,
    dirtyCount,
    vitestSkipped: vitestRes.skipped,
  };
}

async function spawnVitest(
  workspaceRoot: string,
  outputFile: string,
  pm: PackageManager,
  testFiles?: string[]
): Promise<void> {
  const cmd = buildVitestCommand(pm, outputFile, testFiles);
  log(`Spawning vitest in ${workspaceRoot}${testFiles ? ` (${testFiles.length} files)` : ""}`);
  const proc = spawn({
    cmd,
    cwd: workspaceRoot, stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, VITEST_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  if (timedOut) {
    log("Vitest timed out");
    throw new CheckError("VITEST_TIMEOUT");
  }
  if (exitCode !== 0 && !existsSync(outputFile)) {
    const stderr = await new Response(proc.stderr).text();
    if (stderr.includes("command not found") || stderr.includes("vitest")) {
      log(`Vitest not found: ${stderr.slice(0, 200)}`);
      throw new CheckError("VITEST_NOT_FOUND", stderr);
    }
    log(`Vitest failed: exit=${exitCode}`);
    throw new CheckError("VITEST_FAILED", stderr || `exit code ${exitCode}`);
  }
  log(`Vitest completed: exit=${exitCode}`);
}

export async function spawnEslint(workspaceRoot: string, outputFile: string, pm: PackageManager, targetPath?: string): Promise<EslintResult> {
  log(`Spawning eslint in ${workspaceRoot}${targetPath ? ` (scope: ${targetPath})` : ""}`);
  const proc = spawn({
    cmd: buildEslintCommand(pm, outputFile, targetPath),
    cwd: workspaceRoot, stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; proc.kill(); }, ESLINT_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  if (timedOut) {
    log("ESLint timed out");
    return { skipped: true, skipReason: "timeout" };
  }
  const stderr = await new Response(proc.stderr).text();
  const skipReason = detectEslintSkipReason(exitCode, stderr, outputFile);
  if (skipReason) {
    log(`ESLint skipped: ${skipReason}`);
    return { skipped: true, skipReason };
  }
  log(`ESLint completed: exit=${exitCode}`);
  return { skipped: false, outputPath: outputFile };
}

export function detectEslintSkipReason(exitCode: number, stderr: string, outputFile: string): EslintSkipReason | undefined {
  if (stderr.includes("command not found") || stderr.includes("npx: command not found")) { return "not found"; }
  if (stderr.includes("eslint: not found") || stderr.includes("eslint: command not found")) { return "not found"; }
  if (stderr.includes("No ESLint configuration") || stderr.includes("eslint.config")) { return "no config"; }
  if (exitCode !== 0 && !existsSync(outputFile)) { return "failed"; }
  return undefined;
}


export { stripWorkspacePrefix, normalizeEslintPaths, normalizeVitestPaths } from "./normalize.js";
export { buildEslintCommand };
