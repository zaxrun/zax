import type { RustClient } from "./rust-client.js";

const RPC_TIMEOUT_MS = 5000;

interface EngineServerOptions {
  socketPath: string;
  rustClient: RustClient;
}

type BunServer = ReturnType<typeof Bun.serve>;

export function createEngineServer(options: EngineServerOptions): BunServer {
  const { socketPath, rustClient } = options;

  return Bun.serve({
    unix: socketPath,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const headers = { "Content-Type": "application/json" };

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), { headers });
      }

      if (req.method === "GET" && url.pathname === "/version") {
        return handleVersion(rustClient, headers);
      }

      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers,
      });
    },
  });
}

async function handleVersion(
  client: RustClient,
  headers: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const response = await client.ping({}, { signal: controller.signal });
    clearTimeout(timeoutId);
    return new Response(JSON.stringify({ version: response.version }), {
      headers,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const isTimeout =
      error instanceof Error && error.name === "AbortError";

    if (isTimeout) {
      return new Response(
        JSON.stringify({ error: "rust service timeout" }),
        { status: 504, headers }
      );
    }

    return new Response(
      JSON.stringify({ error: "rust service unavailable" }),
      { status: 502, headers }
    );
  }
}
