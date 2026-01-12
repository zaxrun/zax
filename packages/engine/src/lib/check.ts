import { spawn } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  ArtifactKind,
  ArtifactManifestSchema,
  ArtifactRefSchema,
} from "../gen/zax/v1/artifacts_pb.js";
import type { RustClient } from "./rust-client.js";

const VITEST_TIMEOUT_MS = 300_000;
const RPC_TIMEOUT_MS = 30_000;

export interface CheckOptions {
  cacheDir: string;
  workspaceId: string;
  workspaceRoot: string;
  rustClient: RustClient;
}

export interface CheckResult {
  newTestFailures: number;
  fixedTestFailures: number;
}

export type CheckErrorCode =
  | "CONCURRENT_CHECK"
  | "VITEST_NOT_FOUND"
  | "VITEST_TIMEOUT"
  | "VITEST_FAILED"
  | "PARSE_ERROR"
  | "RPC_TIMEOUT"
  | "INTERNAL";

export class CheckError extends Error {
  code: CheckErrorCode;

  constructor(code: CheckErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "CheckError";
  }
}

let checkInProgress = false;

export function isCheckInProgress(): boolean {
  return checkInProgress;
}

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  if (checkInProgress) {
    throw new CheckError("CONCURRENT_CHECK");
  }

  checkInProgress = true;
  try {
    return await executeCheck(options);
  } finally {
    checkInProgress = false;
  }
}

async function executeCheck(options: CheckOptions): Promise<CheckResult> {
  const { cacheDir, workspaceId, workspaceRoot, rustClient } = options;
  const runId = crypto.randomUUID();
  const artifactsDir = join(cacheDir, "artifacts", runId);
  const artifactPath = join(artifactsDir, "vitest.json");

  mkdirSync(artifactsDir, { recursive: true });
  await spawnVitest(workspaceRoot, artifactPath);
  await callIngestManifest(rustClient, workspaceId, runId, artifactPath);
  return await callGetDeltaSummary(rustClient, workspaceId);
}

async function spawnVitest(workspaceRoot: string, outputFile: string): Promise<void> {
  const proc = spawn({
    cmd: ["npx", "vitest", "run", "--reporter=json", `--outputFile=${outputFile}`],
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), VITEST_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (proc.killed) {
    throw new CheckError("VITEST_TIMEOUT");
  }

  if (exitCode !== 0 && !existsSync(outputFile)) {
    const stderr = await new Response(proc.stderr).text();
    if (stderr.includes("command not found") || stderr.includes("vitest")) {
      throw new CheckError("VITEST_NOT_FOUND", stderr);
    }
    throw new CheckError("VITEST_FAILED", stderr || `exit code ${exitCode}`);
  }
}

async function callIngestManifest(
  client: RustClient,
  workspaceId: string,
  runId: string,
  artifactPath: string
): Promise<void> {
  const manifest = create(ArtifactManifestSchema, {
    workspaceId,
    runId,
    artifacts: [
      create(ArtifactRefSchema, {
        artifactId: runId,
        kind: ArtifactKind.TEST_FAILURE,
        path: artifactPath,
        hash: "",
      }),
    ],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    await client.ingestManifest({ manifest }, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new CheckError("RPC_TIMEOUT");
    }
    throw new CheckError("INTERNAL", String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGetDeltaSummary(
  client: RustClient,
  workspaceId: string
): Promise<CheckResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const response = await client.getDeltaSummary({ workspaceId }, { signal: controller.signal });
    return {
      newTestFailures: response.newTestFailures,
      fixedTestFailures: response.fixedTestFailures,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new CheckError("RPC_TIMEOUT");
    }
    throw new CheckError("INTERNAL", String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}
