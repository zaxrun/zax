import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const WORKSPACE_ID_LENGTH = 16;
const CACHE_DIR_MODE = 0o700;

/**
 * Computes workspace ID from directory path.
 * Uses BLAKE2b256 (Bun built-in) instead of BLAKE3 (design spec) because
 * the blake3 npm package has native binding issues with `bun build --compile`.
 * This is acceptable since workspace IDs are local cache keys only.
 */
export function computeWorkspaceId(cwd: string): string {
  const absolutePath = resolve(cwd);
  const hasher = new Bun.CryptoHasher("blake2b256");
  hasher.update(absolutePath);
  return hasher.digest("hex").slice(0, WORKSPACE_ID_LENGTH);
}

export function getCacheDir(workspaceId: string): string {
  const home = homedir();
  const platform = process.platform;

  if (platform === "darwin") {
    return join(home, "Library", "Caches", "zax", workspaceId);
  }

  return join(home, ".cache", "zax", workspaceId);
}

export function ensureCacheDir(cacheDir: string): void {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true, mode: CACHE_DIR_MODE });
    return;
  }

  const stats = statSync(cacheDir);
  const mode = stats.mode & 0o777;

  if (mode !== CACHE_DIR_MODE) {
    throw new Error(
      `Cache directory has wrong permissions: ${mode.toString(8)}, expected 700`
    );
  }
}
