import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWorkspaceId, getCacheDir, ensureCacheDir } from "./workspace.js";

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
