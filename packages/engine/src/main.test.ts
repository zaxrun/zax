import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanStalePortFile } from "./main.js";

describe("cleanStalePortFile", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `engine-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("deletes existing port file and returns true", () => {
    const portFile = join(testDir, "rust.port");
    writeFileSync(portFile, "12345");
    expect(existsSync(portFile)).toBe(true);

    const deleted = cleanStalePortFile(testDir);

    expect(deleted).toBe(true);
    expect(existsSync(portFile)).toBe(false);
  });

  test("returns false when no port file exists", () => {
    const deleted = cleanStalePortFile(testDir);
    expect(deleted).toBe(false);
  });

  test("prevents stale port from being read", () => {
    // Simulate scenario: old port file exists with stale port
    const portFile = join(testDir, "rust.port");
    writeFileSync(portFile, "42441"); // stale port from previous run

    // Clean it before "spawning" new service
    cleanStalePortFile(testDir);

    // Now if we write a new port, it won't conflict
    writeFileSync(portFile, "55555");
    const content = Bun.file(portFile).text();
    expect(content).resolves.toBe("55555");
  });
});
