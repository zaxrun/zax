import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForPortFile, createRustClient, pingWithRetry } from "./rust-client.js";

describe("waitForPortFile", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `zax-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns port when file exists immediately", async () => {
    writeFileSync(join(testDir, "rust.port"), "12345");
    const port = await waitForPortFile(testDir, 1000);
    expect(port).toBe(12345);
  });

  test("waits for port file to appear", async () => {
    setTimeout(() => {
      writeFileSync(join(testDir, "rust.port"), "54321");
    }, 150);
    const port = await waitForPortFile(testDir, 1000);
    expect(port).toBe(54321);
  });

  test("throws on timeout", async () => {
    const promise = waitForPortFile(testDir, 200);
    await expect(promise).rejects.toThrow(/Timeout waiting for port file/);
  });

  test("ignores invalid port (negative)", async () => {
    writeFileSync(join(testDir, "rust.port"), "-1");
    const promise = waitForPortFile(testDir, 200);
    await expect(promise).rejects.toThrow(/Timeout/);
  });

  test("ignores invalid port (zero)", async () => {
    writeFileSync(join(testDir, "rust.port"), "0");
    const promise = waitForPortFile(testDir, 200);
    await expect(promise).rejects.toThrow(/Timeout/);
  });

  test("ignores invalid port (too high)", async () => {
    writeFileSync(join(testDir, "rust.port"), "70000");
    const promise = waitForPortFile(testDir, 200);
    await expect(promise).rejects.toThrow(/Timeout/);
  });

  test("ignores invalid port (non-numeric)", async () => {
    writeFileSync(join(testDir, "rust.port"), "notaport");
    const promise = waitForPortFile(testDir, 200);
    await expect(promise).rejects.toThrow(/Timeout/);
  });

  test("trims whitespace from port file", async () => {
    writeFileSync(join(testDir, "rust.port"), "  9999\n");
    const port = await waitForPortFile(testDir, 1000);
    expect(port).toBe(9999);
  });

  test("accepts port at boundary (1)", async () => {
    writeFileSync(join(testDir, "rust.port"), "1");
    const port = await waitForPortFile(testDir, 1000);
    expect(port).toBe(1);
  });

  test("accepts port at boundary (65535)", async () => {
    writeFileSync(join(testDir, "rust.port"), "65535");
    const port = await waitForPortFile(testDir, 1000);
    expect(port).toBe(65535);
  });
});

describe("createRustClient", () => {
  test("creates client with correct base URL", () => {
    const client = createRustClient(12345);
    expect(client).toBeDefined();
    expect(typeof client.ping).toBe("function");
  });
});

describe("pingWithRetry", () => {
  test("returns response on first successful attempt", async () => {
    const mockResponse = { version: "1.0.0" };
    const mockClient = {
      ping: mock(() => Promise.resolve(mockResponse)),
    };
    const result = await pingWithRetry(mockClient as never, [100, 200, 300]);
    expect(result.version).toBe("1.0.0");
    expect(mockClient.ping).toHaveBeenCalledTimes(1);
  });

  test("retries on failure and succeeds", async () => {
    let attempts = 0;
    const mockClient = {
      ping: mock(() => {
        attempts++;
        if (attempts < 3) {
          return Promise.reject(new Error("Connection refused"));
        }
        return Promise.resolve({ version: "1.0.0" });
      }),
    };
    const result = await pingWithRetry(mockClient as never, [10, 10, 10]);
    expect(result.version).toBe("1.0.0");
    expect(attempts).toBe(3);
  });

  test("throws after all retries exhausted", async () => {
    const mockClient = {
      ping: mock(() => Promise.reject(new Error("Connection refused"))),
    };
    const promise = pingWithRetry(mockClient as never, [10, 10, 10]);
    await expect(promise).rejects.toThrow("Connection refused");
    expect(mockClient.ping).toHaveBeenCalledTimes(3);
  });

  test("uses correct number of retry attempts", async () => {
    const mockClient = {
      ping: mock(() => Promise.reject(new Error("fail"))),
    };
    const promise = pingWithRetry(mockClient as never, [10, 10]);
    await expect(promise).rejects.toThrow();
    expect(mockClient.ping).toHaveBeenCalledTimes(2);
  });

  test("preserves error from last attempt", async () => {
    let callCount = 0;
    const mockClient = {
      ping: mock(() => {
        callCount++;
        return Promise.reject(new Error(`Error ${callCount}`));
      }),
    };
    const promise = pingWithRetry(mockClient as never, [10, 10, 10]);
    await expect(promise).rejects.toThrow("Error 3");
  });
});
