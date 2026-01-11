import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { WorkspaceService, type PingResponse } from "../gen/zax/v1/workspace_pb.js";
import { existsSync, readFileSync } from "node:fs";

const PORT_FILE_POLL_INTERVAL_MS = 100;
const CONNECTION_TIMEOUT_MS = 5000;

export type RustClient = Client<typeof WorkspaceService>;

export async function waitForPortFile(
  cacheDir: string,
  timeoutMs: number
): Promise<number> {
  const portFile = `${cacheDir}/rust.port`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const content = readFileSync(portFile, "utf-8").trim();
      const port = parseInt(content, 10);
      if (!isNaN(port) && port > 0 && port <= 65535) {
        return port;
      }
    }
    await new Promise((r) => setTimeout(r, PORT_FILE_POLL_INTERVAL_MS));
  }

  throw new Error(`Timeout waiting for port file: ${portFile}`);
}

export function createRustClient(port: number): RustClient {
  const transport = createGrpcTransport({
    baseUrl: `http://127.0.0.1:${port}`,
  });
  return createClient(WorkspaceService, transport);
}

export async function pingWithRetry(
  client: RustClient,
  retryDelays: number[]
): Promise<PingResponse> {
  let lastError: Error | undefined;
  const totalAttempts = retryDelays.length;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, CONNECTION_TIMEOUT_MS);

      const response = await client.ping({}, { signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < totalAttempts - 1) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
      }
    }
  }

  throw lastError ?? new Error("All ping retries failed");
}
