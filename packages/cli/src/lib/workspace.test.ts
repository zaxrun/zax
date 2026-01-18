import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeWorkspaceId,
  getCacheDir,
  ensureCacheDir,
  detectWorkspaceRoot,
  derivePackageScope,
  getWorkspaceInfo,
} from "./workspace.js";

describe("computeWorkspaceId", () => {
  test("same cwd returns same workspace ID (deterministic)", () => {
    const id1 = computeWorkspaceId("/some/path");
    const id2 = computeWorkspaceId("/some/path");
    expect(id1).toBe(id2);
  });

  test("different cwd returns different workspace ID", () => {
    const id1 = computeWorkspaceId("/path/one");
    const id2 = computeWorkspaceId("/path/two");
    expect(id1).not.toBe(id2);
  });

  test("workspace ID is 16 hex characters", () => {
    const id = computeWorkspaceId("/any/path");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("resolves relative paths before hashing", () => {
    const absolute = computeWorkspaceId("/workspace/zax");
    const withDot = computeWorkspaceId("/workspace/zax/./");
    const withDotDot = computeWorkspaceId("/workspace/zax/foo/..");
    expect(absolute).toBe(withDot);
    expect(absolute).toBe(withDotDot);
  });
});

describe("getCacheDir", () => {
  const originalPlatform = process.platform;

  test("returns Linux cache path on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const cacheDir = getCacheDir("abc123");
    expect(cacheDir).toContain(".cache/zax/abc123");
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("returns macOS cache path on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const cacheDir = getCacheDir("abc123");
    expect(cacheDir).toContain("Library/Caches/zax/abc123");
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  test("includes workspace ID in path", () => {
    const cacheDir = getCacheDir("testworkspaceid");
    expect(cacheDir).toContain("testworkspaceid");
  });
});

describe("ensureCacheDir", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `zax-test-${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("creates directory with 0700 permissions", () => {
    ensureCacheDir(testDir);
    const stats = statSync(testDir);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("creates nested directories", () => {
    const nestedDir = join(testDir, "nested", "deep");
    ensureCacheDir(nestedDir);
    const stats = statSync(nestedDir);
    expect(stats.isDirectory()).toBe(true);
  });

  test("succeeds if directory already exists with correct permissions", () => {
    mkdirSync(testDir, { recursive: true, mode: 0o700 });
    expect(() => ensureCacheDir(testDir)).not.toThrow();
  });

  test("throws error if directory has wrong permissions", () => {
    mkdirSync(testDir, { recursive: true, mode: 0o755 });
    expect(() => ensureCacheDir(testDir)).toThrow(/wrong permissions.*755.*expected 700/);
  });

  test("throws error if directory has 0777 permissions", () => {
    mkdirSync(testDir, { recursive: true, mode: 0o777 });
    expect(() => ensureCacheDir(testDir)).toThrow(/wrong permissions/);
  });
});

describe("detectWorkspaceRoot", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `zax-root-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("returns .git directory as root when no monorepo markers", () => {
    const gitDir = join(testDir, ".git");
    mkdirSync(gitDir);
    const subDir = join(testDir, "packages", "auth", "src");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    expect(root).toBe(testDir);
  });

  test("returns pnpm-workspace.yaml location as root", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*");
    const subDir = join(testDir, "packages", "auth");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    expect(root).toBe(testDir);
  });

  test("returns turbo.json location as root", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "turbo.json"), "{}");
    const subDir = join(testDir, "packages", "auth");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    expect(root).toBe(testDir);
  });

  test("returns lerna.json location as root", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "lerna.json"), "{}");
    const subDir = join(testDir, "packages", "auth");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    expect(root).toBe(testDir);
  });

  test("returns package.json with workspaces field as root", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    const subDir = join(testDir, "packages", "auth");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    expect(root).toBe(testDir);
  });

  test("ignores package.json without workspaces field", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "root" }));
    const subDir = join(testDir, "packages", "auth");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    // Should fall back to .git location since package.json has no workspaces
    expect(root).toBe(testDir);
  });

  test("prefers nearest marker when multiple exist at different levels", () => {
    // Create outer marker
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*");

    // Create inner marker (closer to cwd)
    const innerDir = join(testDir, "packages", "monorepo");
    mkdirSync(innerDir, { recursive: true });
    writeFileSync(join(innerDir, "turbo.json"), "{}");

    const subDir = join(innerDir, "apps", "web");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    // Should return the nearest marker (inner turbo.json)
    expect(root).toBe(innerDir);
  });

  test("stops at .git boundary even when markers exist above", () => {
    // Create marker above .git
    writeFileSync(join(testDir, "pnpm-workspace.yaml"), "packages:\n  - projects/*");

    // Create .git in subdirectory (the boundary)
    const projectDir = join(testDir, "projects", "myrepo");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, ".git"));

    const subDir = join(projectDir, "src");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    // Should stop at .git, not go above to pnpm-workspace.yaml
    expect(root).toBe(projectDir);
  });

  test("returns cwd when no .git and no markers found", () => {
    const subDir = join(testDir, "some", "deep", "path");
    mkdirSync(subDir, { recursive: true });

    const root = detectWorkspaceRoot(subDir);
    // Should return the starting directory (no markers found)
    expect(root).toBe(subDir);
  });

  test("handles cwd at root of monorepo", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*");

    const root = detectWorkspaceRoot(testDir);
    expect(root).toBe(testDir);
  });
});

describe("derivePackageScope", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `zax-scope-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("returns null when cwd equals workspace root", () => {
    const scope = derivePackageScope(testDir, testDir);
    expect(scope).toBeNull();
  });

  test("returns relative path from nearest package.json ancestor", () => {
    const pkgDir = join(testDir, "packages", "auth");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@app/auth" }));

    const srcDir = join(pkgDir, "src", "utils");
    mkdirSync(srcDir, { recursive: true });

    const scope = derivePackageScope(srcDir, testDir);
    expect(scope).toBe("packages/auth");
  });

  test("returns null when no package.json between cwd and root", () => {
    const subDir = join(testDir, "some", "deep", "path");
    mkdirSync(subDir, { recursive: true });

    const scope = derivePackageScope(subDir, testDir);
    expect(scope).toBeNull();
  });

  test("returns package directory path, not subdirectory", () => {
    const pkgDir = join(testDir, "packages", "web");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@app/web" }));

    // Create deep subdirectory
    const deepDir = join(pkgDir, "src", "components", "ui", "buttons");
    mkdirSync(deepDir, { recursive: true });

    const scope = derivePackageScope(deepDir, testDir);
    expect(scope).toBe("packages/web");
  });

  test("handles nested package.json files correctly", () => {
    // Create outer package
    const outerPkg = join(testDir, "packages", "app");
    mkdirSync(outerPkg, { recursive: true });
    writeFileSync(join(outerPkg, "package.json"), JSON.stringify({ name: "@app/app" }));

    // Create inner package (nested)
    const innerPkg = join(outerPkg, "packages", "shared");
    mkdirSync(innerPkg, { recursive: true });
    writeFileSync(join(innerPkg, "package.json"), JSON.stringify({ name: "@app/shared" }));

    const srcDir = join(innerPkg, "src");
    mkdirSync(srcDir, { recursive: true });

    // Should return nearest package.json (inner)
    const scope = derivePackageScope(srcDir, testDir);
    expect(scope).toBe("packages/app/packages/shared");
  });

  test("normalizes path separators to forward slashes", () => {
    const pkgDir = join(testDir, "packages", "auth");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@app/auth" }));

    const scope = derivePackageScope(pkgDir, testDir);
    // Should use forward slashes regardless of platform
    expect(scope).toBe("packages/auth");
    expect(scope).not.toContain("\\");
  });
});

describe("getWorkspaceInfo", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `zax-info-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("returns workspaceRoot and packageScope together", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*");

    const pkgDir = join(testDir, "packages", "auth");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@app/auth" }));

    const srcDir = join(pkgDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const info = getWorkspaceInfo(srcDir);
    expect(info.workspaceRoot).toBe(testDir);
    expect(info.packageScope).toBe("packages/auth");
  });

  test("returns null packageScope when at workspace root", () => {
    mkdirSync(join(testDir, ".git"));
    writeFileSync(join(testDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*");

    const info = getWorkspaceInfo(testDir);
    expect(info.workspaceRoot).toBe(testDir);
    expect(info.packageScope).toBeNull();
  });

  test("returns null packageScope for single-package repo", () => {
    mkdirSync(join(testDir, ".git"));
    // No monorepo markers, no nested package.json

    const srcDir = join(testDir, "src");
    mkdirSync(srcDir, { recursive: true });

    const info = getWorkspaceInfo(srcDir);
    expect(info.workspaceRoot).toBe(testDir);
    expect(info.packageScope).toBeNull();
  });
});
