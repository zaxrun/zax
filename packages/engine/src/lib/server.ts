/**
 * Engine HTTP Server
 *
 * Provides HTTP/JSON API over Unix socket for CLI communication.
 *
 * ## API Versioning Strategy
 *
 * Current version: v1 (implicit, unversioned endpoints)
 *
 * Compatibility policy:
 * - CLI and Engine versions must match exactly (same release)
 * - Use `/version` endpoint to verify compatibility before operations
 * - Breaking changes require coordinated CLI + Engine releases
 *
 * Future versioning (when needed):
 * - Add `/v2/` prefix for breaking changes
 * - Maintain `/v1/` endpoints for one release cycle
 * - CLI should check version and warn on mismatch
 */
import { existsSync, statSync } from "node:fs";
import type { RustClient } from "./rust-client.js";
import { runCheck, isCheckInProgress, type CheckError } from "./check.js";

const RPC_TIMEOUT_MS = 5000;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{16}$/;
/** Minimum interval between check requests (1 second). */
const CHECK_RATE_LIMIT_MS = 1000;

let lastCheckTime = 0;

/** Validates workspace_id is 16 lowercase hex characters. */
export function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_PATTERN.test(id);
}

/** Validates workspace_root is an existing directory. */
export function isValidWorkspaceRoot(path: string): boolean {
  if (!path || path.length === 0) {
    return false;
  }
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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

async function parseCheckRequest(req: Request): Promise<CheckRequestBody | null> {
  try {
    return (await req.json()) as CheckRequestBody;
  } catch {
    return null;
  }
}

function jsonResponse(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

function validateCheckRequest(body: CheckRequestBody | null, headers: Record<string, string>): Response | null {
  if (!body) {
    return jsonResponse({ error: "invalid request body" }, 400, headers);
  }
  if (!isValidWorkspaceId(body.workspace_id)) {
    return jsonResponse({ error: "invalid workspace_id format" }, 400, headers);
  }
  if (!isValidWorkspaceRoot(body.workspace_root)) {
    return jsonResponse({ error: "workspace_root must be an existing directory" }, 400, headers);
  }
  return null;
}

/** Check rate limiting. Returns 429 response if rate limited, null otherwise. */
function checkRateLimit(headers: Record<string, string>): Response | null {
  const now = Date.now();
  const elapsed = now - lastCheckTime;
  if (elapsed < CHECK_RATE_LIMIT_MS) {
    const retryAfter = Math.ceil((CHECK_RATE_LIMIT_MS - elapsed) / 1000);
    return jsonResponse(
      { error: "rate limited", retry_after_seconds: retryAfter },
      429,
      { ...headers, "Retry-After": String(retryAfter) }
    );
  }
  return null;
}

async function handleCheck(
  req: Request,
  cacheDir: string,
  client: RustClient,
  headers: Record<string, string>
): Promise<Response> {
  const rateLimitResponse = checkRateLimit(headers);
  if (rateLimitResponse) { return rateLimitResponse; }

  if (isCheckInProgress()) {
    return jsonResponse({ error: "check already in progress" }, 409, headers);
  }

  const body = await parseCheckRequest(req);
  const validationError = validateCheckRequest(body, headers);
  if (validationError) {
    return validationError;
  }

  // Update last check time before starting
  lastCheckTime = Date.now();

  try {
    const result = await runCheck({
      cacheDir,
      workspaceId: body!.workspace_id,
      workspaceRoot: body!.workspace_root,
      rustClient: client,
    });
    return jsonResponse({
      new_test_failures: result.newTestFailures,
      fixed_test_failures: result.fixedTestFailures,
      new_findings: result.newFindings,
      fixed_findings: result.fixedFindings,
      eslint_skipped: result.eslintSkipped,
      eslint_skip_reason: result.eslintSkipReason,
    }, 200, headers);
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
