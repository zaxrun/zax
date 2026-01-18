import { existsSync, mkdirSync, statSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, relative, dirname, sep } from "node:path";

const WORKSPACE_ID_LENGTH = 16;
const CACHE_DIR_MODE = 0o700;

/** Monorepo marker files (in order of preference). */
const MONOREPO_MARKERS = [
  "pnpm-workspace.yaml",
  "turbo.json",
  "lerna.json",
];

export interface WorkspaceInfo {
  workspaceRoot: string;
  packageScope: string | null;
}

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

/** Checks if a directory contains a .git directory. */
function hasGitDir(dir: string): boolean {
  try {
    const gitPath = join(dir, ".git");
    return existsSync(gitPath) && statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

/** Checks if a directory contains any monorepo marker. */
function hasMonorepoMarker(dir: string): boolean {
  try {
    // Check for standard marker files
    for (const marker of MONOREPO_MARKERS) {
      if (existsSync(join(dir, marker))) {
        return true;
      }
    }
    // Check for package.json with workspaces field
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const content = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as { workspaces?: unknown };
      if (pkg.workspaces) {
        return true;
      }
    }
  } catch {
    // Ignore errors, continue checking
  }
  return false;
}

/** Checks if a directory contains a package.json file. */
function hasPackageJson(dir: string): boolean {
  try {
    return existsSync(join(dir, "package.json"));
  } catch {
    return false;
  }
}

/** Safely resolves symlinks and returns canonical path. */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Checks if a path is within a root directory. */
function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !rel.startsWith(sep);
}

/**
 * Detects the workspace root by walking up from cwd.
 *
 * Algorithm:
 * 1. Walk up from cwd to find .git boundary first
 * 2. Within .git boundary, find nearest monorepo marker
 * 3. Stop at .git even if markers exist above
 * 4. Fallback: use .git as root when no markers, use cwd when no .git
 *
 * Property 1: Root Detection Finds Correct Boundary
 * Property 2: Root Detection Handles Errors Gracefully
 * Property 9: Single-Package Repos Work Without Configuration
 * Property 10: Symlink Boundaries Enforced
 */
export function detectWorkspaceRoot(cwd: string): string {
  const canonicalCwd = safeRealpath(cwd);
  if (!canonicalCwd) {
    // eslint-disable-next-line no-console
    console.warn(`Warning: Using ${cwd} as workspace root (could not resolve path)`);
    return cwd;
  }

  let currentDir = canonicalCwd;
  let gitRoot: string | null = null;
  let nearestMarker: string | null = null;

  // Walk up to find .git and monorepo markers
  while (currentDir !== dirname(currentDir)) {
    try {
      // Check for .git first (boundary)
      if (!gitRoot && hasGitDir(currentDir)) {
        gitRoot = currentDir;
      }

      // Check for monorepo markers (within git boundary)
      if (!nearestMarker && hasMonorepoMarker(currentDir)) {
        nearestMarker = currentDir;
      }

      // If we found a monorepo marker, use it
      if (nearestMarker) {
        return nearestMarker;
      }

      // If we found .git, stop walking (it's the boundary)
      if (gitRoot) {
        return gitRoot;
      }

      currentDir = dirname(currentDir);
    } catch {
      // Permission error - stop and use cwd
      // eslint-disable-next-line no-console
      console.warn(`Warning: Using ${canonicalCwd} as workspace root (permission denied on ${currentDir})`);
      return canonicalCwd;
    }
  }

  // No markers or .git found, use cwd
  return canonicalCwd;
}

/**
 * Derives the package scope from cwd relative to workspace root.
 *
 * Finds the nearest package.json ancestor within workspace_root.
 * Returns null when cwd equals workspace_root or no package.json found.
 *
 * Property 4: Package Scope Derived From Nearest Package.json
 * Property 10: Symlink Boundaries Enforced
 */
export function derivePackageScope(cwd: string, workspaceRoot: string): string | null {
  const canonicalCwd = safeRealpath(cwd);
  const canonicalRoot = safeRealpath(workspaceRoot);

  if (!canonicalCwd || !canonicalRoot) {
    return null;
  }

  // If cwd equals workspace root, no package scope
  if (canonicalCwd === canonicalRoot) {
    return null;
  }

  // Verify cwd is within workspace root
  if (!isWithinRoot(canonicalCwd, canonicalRoot)) {
    // eslint-disable-next-line no-console
    console.warn(`Warning: Skipping symlink ${cwd}: resolves to ${canonicalCwd} outside workspace ${canonicalRoot}`);
    return null;
  }

  // Walk up from cwd to find nearest package.json
  let currentDir = canonicalCwd;

  while (currentDir !== canonicalRoot && isWithinRoot(currentDir, canonicalRoot)) {
    if (hasPackageJson(currentDir)) {
      // Return relative path from workspace root
      const scope = relative(canonicalRoot, currentDir);
      // Normalize to forward slashes for cross-platform consistency
      return scope.split(sep).join("/");
    }
    currentDir = dirname(currentDir);
  }

  // No package.json found between cwd and root
  return null;
}

/**
 * Gets full workspace info (root and scope) from cwd.
 */
export function getWorkspaceInfo(cwd: string): WorkspaceInfo {
  const workspaceRoot = detectWorkspaceRoot(cwd);
  const packageScope = derivePackageScope(cwd, workspaceRoot);
  return { workspaceRoot, packageScope };
}
