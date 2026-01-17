import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineServer, isValidWorkspaceId, isValidWorkspaceRoot } from "./server.js";

describe("createEngineServer", () => {
  let socketPath: string;
  let cacheDir: string;
  let server: ReturnType<typeof createEngineServer>;

  beforeEach(() => {
    socketPath = join(tmpdir(), `zax-test-${Date.now()}-${Math.random()}.sock`);
    cacheDir = join(tmpdir(), `zax-cache-${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    if (server) {
      void server.stop(true);
    }
    if (existsSync(socketPath)) {
      rmSync(socketPath, { force: true });
    }
  });

  async function fetch(path: string, method = "GET"): Promise<Response> {
    return Bun.fetch(`http://localhost${path}`, {
      unix: socketPath,
      method,
    });
  }

  describe("GET /health", () => {
    test("returns successful response with correct headers", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, cacheDir, rustClient: mockClient as never });

      const response = await fetch("/health");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toEqual({ status: "ok" });
    });
  });

  describe("GET /version", () => {
    test("returns version from Rust client", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "0.1.0" })) };
      server = createEngineServer({ socketPath, cacheDir, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toEqual({ version: "0.1.0" });
    });

    test("handles Rust client failure", async () => {
      const mockClient = { ping: mock(() => Promise.reject(new Error("Connection refused"))) };
      server = createEngineServer({ socketPath, cacheDir, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.status).toBe(502);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toEqual({ error: "rust service unavailable" });
    });

    test("handles Rust client timeout", async () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      const mockClient = { ping: mock(() => Promise.reject(abortError)) };
      server = createEngineServer({ socketPath, cacheDir, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.status).toBe(504);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toEqual({ error: "rust service timeout" });
    });
  });

  describe("unknown routes", () => {
    test("returns 404 for unknown path", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, cacheDir, rustClient: mockClient as never });

      const response = await fetch("/unknown");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    });

    test("returns 404 for POST to /health", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, cacheDir, rustClient: mockClient as never });

      const response = await fetch("/health", "POST");
      expect(response.status).toBe(404);
    });
  });
});

// Security: Input validation tests
describe("isValidWorkspaceId", () => {
  test("accepts valid 16-char hex string", () => {
    expect(isValidWorkspaceId("0123456789abcdef")).toBe(true);
    expect(isValidWorkspaceId("4191cb01c7689684")).toBe(true);
  });

  test("rejects uppercase hex", () => {
    expect(isValidWorkspaceId("0123456789ABCDEF")).toBe(false);
  });

  test("rejects too short", () => {
    expect(isValidWorkspaceId("0123456789abcde")).toBe(false);  // 15 chars
    expect(isValidWorkspaceId("")).toBe(false);
  });

  test("rejects too long", () => {
    expect(isValidWorkspaceId("0123456789abcdef0")).toBe(false); // 17 chars
  });

  test("rejects non-hex letters", () => {
    expect(isValidWorkspaceId("0123456789abcdeg")).toBe(false);
  });

  test("rejects separators", () => {
    expect(isValidWorkspaceId("workspace-id-123")).toBe(false);
  });
});

describe("isValidWorkspaceRoot", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `zax-ws-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("accepts existing directory", () => {
    expect(isValidWorkspaceRoot(testDir)).toBe(true);
  });

  test("rejects non-existent path", () => {
    expect(isValidWorkspaceRoot("/nonexistent/path/12345")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidWorkspaceRoot("")).toBe(false);
  });

  test("rejects file path (not directory)", async () => {
    const filePath = join(testDir, "file.txt");
    await Bun.write(filePath, "test");
    expect(isValidWorkspaceRoot(filePath)).toBe(false);
  });
});
