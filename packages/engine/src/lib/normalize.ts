import { readFileSync, writeFileSync, renameSync } from "node:fs";

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
