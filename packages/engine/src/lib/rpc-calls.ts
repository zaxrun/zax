import { create } from "@bufbuild/protobuf";
import { ArtifactKind, ArtifactManifestSchema, ArtifactRefSchema, type ArtifactRef } from "../gen/zax/v1/artifacts_pb.js";
import type { RustClient } from "./rust-client.js";
import { CheckError, type EslintSkipReason } from "./check.js";

const RPC_TIMEOUT_MS = 30_000;

interface EslintResult { skipped: boolean; skipReason?: EslintSkipReason; outputPath?: string; }
interface IngestParams { workspaceId: string; runId: string; vitestPath: string; eslintResult: EslintResult; packageScope: string; }

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

export async function ingestArtifacts(client: RustClient, params: IngestParams): Promise<void> {
  const { workspaceId, runId, vitestPath, eslintResult, packageScope } = params;
  const artifacts = buildArtifactList(runId, vitestPath, eslintResult);
  const manifest = create(ArtifactManifestSchema, { workspaceId, runId, artifacts });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    await client.ingestManifest({ manifest, packageScope }, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") { throw new CheckError("RPC_TIMEOUT"); }
    throw new CheckError("INTERNAL", String(error));
  } finally { clearTimeout(timeoutId); }
}

export interface DeltaResult {
  newTestFailures: number;
  fixedTestFailures: number;
  newFindings: number;
  fixedFindings: number;
}

export async function callGetDeltaSummary(client: RustClient, workspaceId: string, packageScope: string): Promise<DeltaResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const r = await client.getDeltaSummary({ workspaceId, packageScope }, { signal: controller.signal });
    return { newTestFailures: r.newTestFailures, fixedTestFailures: r.fixedTestFailures, newFindings: r.newFindings, fixedFindings: r.fixedFindings };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") { throw new CheckError("RPC_TIMEOUT"); }
    throw new CheckError("INTERNAL", String(error));
  } finally { clearTimeout(timeoutId); }
}
