import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

describe("Engine Integration", () => {
  let cacheDir: string;
  let engineProc: Subprocess | undefined;
  let socketPath: string;

  function getEnginePath(): string {
    const thisFile = new URL(import.meta.url).pathname;
    const srcDir = resolve(thisFile, "..");
    return join(srcDir, "main.ts");
  }

  async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for socket: ${path}`);
  }

  async function fetch(path: string): Promise<Response> {
    return Bun.fetch(`http://localhost${path}`, {
      unix: socketPath,
    });
  }

  beforeAll(async () => {
    cacheDir = join(tmpdir(), `zax-integration-${Date.now()}`);
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    socketPath = join(cacheDir, "zax.sock");

    const enginePath = getEnginePath();
    engineProc = Bun.spawn(["bun", "run", enginePath, cacheDir], {
      stdout: "ignore",
      stderr: "pipe",
    });

    await waitForSocket(socketPath, 15000);
  }, 20000);

  afterAll(async () => {
    if (engineProc) {
      engineProc.kill("SIGTERM");
      const deadline = Date.now() + 3000;
      while (engineProc.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (engineProc.exitCode === null) {
        engineProc.kill("SIGKILL");
      }
    }

    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("engine creates socket file", () => {
    expect(existsSync(socketPath)).toBe(true);
  });

  test("engine creates pid file", () => {
    expect(existsSync(join(cacheDir, "engine.pid"))).toBe(true);
  });

  test("engine creates log file", () => {
    expect(existsSync(join(cacheDir, "engine.log"))).toBe(true);
  });

  test("GET /health returns 200", async () => {
    const response = await fetch("/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  test("GET /version returns version from Rust", async () => {
    const response = await fetch("/version");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("GET /version returns 0.1.0", async () => {
    const response = await fetch("/version");
    const body = (await response.json()) as { version: string };
    expect(body.version).toBe("0.1.0");
  });

  test("GET /unknown returns 404", async () => {
    const response = await fetch("/unknown");
    expect(response.status).toBe(404);
  });
});
