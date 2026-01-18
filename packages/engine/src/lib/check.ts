import { spawn } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ArtifactKind, ArtifactManifestSchema, ArtifactRefSchema, type ArtifactRef } from "../gen/zax/v1/artifacts_pb.js";
import { type RustClient, getAffectedTests } from "./rust-client.js";
import { log } from "./logger.js";

const VITEST_TIMEOUT_MS = 300_000;
const ESLINT_TIMEOUT_MS = 300_000;
const RPC_TIMEOUT_MS = 30_000;

export interface CheckOptions {
  cacheDir: string;
  workspaceId: string;
  workspaceRoot: string;
  rustClient: RustClient;
  deopt?: boolean;
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

export type CheckErrorCode =
  | "CONCURRENT_CHECK" | "VITEST_NOT_FOUND" | "VITEST_TIMEOUT"
  | "VITEST_FAILED" | "PARSE_ERROR" | "RPC_TIMEOUT" | "INTERNAL";

export class CheckError extends Error {
  code: CheckErrorCode;
  constructor(code: CheckErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "CheckError";
  }
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

async function executeCheck(options: CheckOptions): Promise<CheckResult> {
  const { cacheDir, workspaceId, workspaceRoot, rustClient, deopt } = options;
  const runId = crypto.randomUUID();
  const artifactsDir = join(cacheDir, "artifacts", runId);
  mkdirSync(artifactsDir, { recursive: true });

  // Get affected tests from Rust service
  const forceFull = deopt ?? false;
  const affected = await getAffectedTests(rustClient, workspaceId, forceFull);
  const dirtyCount = affected.dirtyFiles.length;
  const affectedCount = affected.testFiles.length;
  log(`Affected: dirty=${dirtyCount}, tests=${affectedCount}, full_run=${affected.isFullRun}`);

  const vitestPath = join(artifactsDir, "vitest.json");
  let vitestSkipped = false;
  let skippedCount = 0;

  if (affected.isFullRun) {
    // Full run: no file arguments
    await spawnVitest(workspaceRoot, vitestPath);
  } else if (affectedCount > 0) {
    // Selective run: pass test files as arguments
    await spawnVitest(workspaceRoot, vitestPath, affected.testFiles);
  } else {
    // No tests affected: skip vitest entirely
    vitestSkipped = true;
    log("No tests affected, skipping vitest");
  }

  if (existsSync(vitestPath)) {
    normalizeVitestPaths(vitestPath, workspaceRoot);
    // Count skipped tests (only meaningful when we have a vitest output)
    if (!affected.isFullRun && !vitestSkipped) {
      // TODO: Parse vitest output to get total test count for skippedCount
      skippedCount = 0;
    }
  }
  const eslintResult = await spawnEslint(workspaceRoot, join(artifactsDir, "eslint.json"));
  if (!eslintResult.skipped && eslintResult.outputPath) {
    normalizeEslintPaths(eslintResult.outputPath, workspaceRoot);
  }
  await ingestArtifacts(rustClient, { workspaceId, runId, vitestPath, eslintResult });
  const delta = await callGetDeltaSummary(rustClient, workspaceId);
  return {
    ...delta,
    eslintSkipped: eslintResult.skipped,
    eslintSkipReason: eslintResult.skipReason,
    affectedCount,
    skippedCount,
    dirtyCount,
    vitestSkipped,
  };
}

async function spawnVitest(
  workspaceRoot: string,
  outputFile: string,
  testFiles?: string[]
): Promise<void> {
  const cmd = ["npx", "vitest", "run", "--reporter=json", `--outputFile=${outputFile}`];
  if (testFiles && testFiles.length > 0) {
    cmd.push(...testFiles);
  }
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

export async function spawnEslint(workspaceRoot: string, outputFile: string): Promise<EslintResult> {
  log(`Spawning eslint in ${workspaceRoot}`);
  const proc = spawn({
    cmd: buildEslintCommand(outputFile),
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

interface IngestParams { workspaceId: string; runId: string; vitestPath: string; eslintResult: EslintResult; }

async function ingestArtifacts(client: RustClient, params: IngestParams): Promise<void> {
  const { workspaceId, runId, vitestPath, eslintResult } = params;
  const artifacts = buildArtifactList(runId, vitestPath, eslintResult);
  const manifest = create(ArtifactManifestSchema, { workspaceId, runId, artifacts });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    await client.ingestManifest({ manifest }, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") { throw new CheckError("RPC_TIMEOUT"); }
    throw new CheckError("INTERNAL", String(error));
  } finally { clearTimeout(timeoutId); }
}

function buildArtifactList(runId: string, vitestPath: string, eslintResult: EslintResult): ArtifactRef[] {
  const artifacts: ArtifactRef[] = [
    create(ArtifactRefSchema, { artifactId: `${runId}-vitest`, kind: ArtifactKind.TEST_FAILURE, path: vitestPath, hash: "" }),
  ];
  if (!eslintResult.skipped && eslintResult.outputPath) {
    artifacts.push(create(ArtifactRefSchema, {
      artifactId: `${runId}-eslint`, kind: ArtifactKind.FINDING, path: eslintResult.outputPath, hash: "",
    }));
  }
  return artifacts;
}

async function callGetDeltaSummary(client: RustClient, workspaceId: string): Promise<{
  newTestFailures: number; fixedTestFailures: number; newFindings: number; fixedFindings: number;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const r = await client.getDeltaSummary({ workspaceId }, { signal: controller.signal });
    return { newTestFailures: r.newTestFailures, fixedTestFailures: r.fixedTestFailures, newFindings: r.newFindings, fixedFindings: r.fixedFindings };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") { throw new CheckError("RPC_TIMEOUT"); }
    throw new CheckError("INTERNAL", String(error));
  } finally { clearTimeout(timeoutId); }
}

/** Strips workspace root prefix from a path. */
export function stripWorkspacePrefix(path: string, workspaceRoot: string): string {
  const prefix = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Atomically writes content to file using temp file + rename. */
function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, filePath);
}

export function normalizeEslintPaths(filePath: string, workspaceRoot: string): void {
  const content = readFileSync(filePath, "utf-8");
  const results = JSON.parse(content) as Array<{ filePath?: string }>;
  for (const result of results) {
    if (result.filePath) {
      result.filePath = stripWorkspacePrefix(result.filePath, workspaceRoot);
    }
  }
  atomicWriteFile(filePath, JSON.stringify(results));
}

export function normalizeVitestPaths(filePath: string, workspaceRoot: string): void {
  const content = readFileSync(filePath, "utf-8");
  const output = JSON.parse(content) as { testResults?: Array<{ name?: string }> };
  for (const result of output.testResults ?? []) {
    if (result.name) {
      result.name = stripWorkspacePrefix(result.name, workspaceRoot);
    }
  }
  atomicWriteFile(filePath, JSON.stringify(output));
}

export function buildEslintCommand(outputPath: string): string[] {
  return ["npx", "eslint", "-f", "json", "-o", outputPath, "."];
}
