import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineServer } from "./server.js";

describe("createEngineServer", () => {
  let socketPath: string;
  let server: ReturnType<typeof createEngineServer>;

  beforeEach(() => {
    socketPath = join(tmpdir(), `zax-test-${Date.now()}-${Math.random()}.sock`);
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
    test("returns 200 with status ok", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    });

    test("returns Content-Type application/json", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/health");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });

  describe("GET /version", () => {
    test("returns 200 with version when Rust client succeeds", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "0.1.0" })) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: "0.1.0" });
    });

    test("returns 502 when Rust client fails", async () => {
      const mockClient = { ping: mock(() => Promise.reject(new Error("Connection refused"))) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "rust service unavailable" });
    });

    test("returns 504 when Rust client times out", async () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      const mockClient = { ping: mock(() => Promise.reject(abortError)) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: "rust service timeout" });
    });

    test("returns Content-Type application/json on success", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    test("returns Content-Type application/json on error", async () => {
      const mockClient = { ping: mock(() => Promise.reject(new Error("fail"))) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/version");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });
  });

  describe("unknown routes", () => {
    test("returns 404 for unknown path", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/unknown");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    });

    test("returns 404 for POST to /health", async () => {
      const mockClient = { ping: mock(() => Promise.resolve({ version: "1.0.0" })) };
      server = createEngineServer({ socketPath, rustClient: mockClient as never });

      const response = await fetch("/health", "POST");
      expect(response.status).toBe(404);
    });
  });
});
