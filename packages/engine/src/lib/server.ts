import type { RustClient } from "./rust-client.js";
import { runCheck, isCheckInProgress, type CheckError } from "./check.js";

const RPC_TIMEOUT_MS = 5000;

interface EngineServerOptions {
  socketPath: string;
  cacheDir: string;
  rustClient: RustClient;
}

type BunServer = ReturnType<typeof Bun.serve>;

export function createEngineServer(options: EngineServerOptions): BunServer {
  const { socketPath, cacheDir, rustClient } = options;

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

      if (req.method === "POST" && url.pathname === "/check") {
        return handleCheck(req, cacheDir, rustClient, headers);
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

interface CheckRequestBody {
  workspace_id: string;
  workspace_root: string;
}

async function handleCheck(
  req: Request,
  cacheDir: string,
  client: RustClient,
  headers: Record<string, string>
): Promise<Response> {
  if (isCheckInProgress()) {
    return new Response(JSON.stringify({ error: "check already in progress" }), {
      status: 409,
      headers,
    });
  }

  let body: CheckRequestBody;
  try {
    body = (await req.json()) as CheckRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "invalid request body" }), {
      status: 400,
      headers,
    });
  }

  try {
    const result = await runCheck({
      cacheDir,
      workspaceId: body.workspace_id,
      workspaceRoot: body.workspace_root,
      rustClient: client,
    });

    return new Response(
      JSON.stringify({
        new_test_failures: result.newTestFailures,
        fixed_test_failures: result.fixedTestFailures,
      }),
      { headers }
    );
  } catch (err) {
    return mapCheckError(err as CheckError, headers);
  }
}

function mapCheckError(err: CheckError, headers: Record<string, string>): Response {
  switch (err.code) {
    case "CONCURRENT_CHECK":
      return new Response(JSON.stringify({ error: "check already in progress" }), {
        status: 409,
        headers,
      });
    case "VITEST_TIMEOUT":
    case "RPC_TIMEOUT":
      return new Response(JSON.stringify({ error: `timeout: ${err.code}` }), {
        status: 504,
        headers,
      });
    case "VITEST_NOT_FOUND":
      return new Response(JSON.stringify({ error: "vitest not found", code: err.code }), {
        status: 500,
        headers,
      });
    case "VITEST_FAILED":
    case "PARSE_ERROR":
    case "INTERNAL":
      return new Response(JSON.stringify({ error: err.message, code: err.code }), {
        status: 500,
        headers,
      });
    default:
      return new Response(JSON.stringify({ error: "unknown error" }), {
        status: 500,
        headers,
      });
  }
}
