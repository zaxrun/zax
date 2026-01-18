import { existsSync } from "node:fs";

/** Timeout for version/health checks (5 seconds). */
const VERSION_TIMEOUT_MS = 5000;
/** Timeout for check operations (10 minutes to cover vitest + eslint). */
const CHECK_TIMEOUT_MS = 600000;

interface VersionResponse {
  version: string;
}

interface CheckResponse {
  new_test_failures: number;
  fixed_test_failures: number;
  new_findings: number;
  fixed_findings: number;
  eslint_skipped: boolean;
  eslint_skip_reason?: string;
  affected_count: number;
  skipped_count: number;
  dirty_count: number;
  vitest_skipped: boolean;
}

interface ErrorResponse {
  error: string;
}

export interface PostCheckOptions {
  socketPath: string;
  workspaceId: string;
  workspaceRoot: string;
  packageScope: string | null;
  deopt?: boolean;
}

/** Safely parse error response body, falling back to status code on parse failure. */
async function parseErrorResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ErrorResponse;
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Timeout for health check (5 seconds). */
const HEALTH_TIMEOUT_MS = 5000;

export async function connectToEngine(socketPath: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const url = `http://localhost/health`;
    const response = await fetch(url, { unix: socketPath, signal: controller.signal } as RequestInit);
    if (!response.ok) {
      throw new Error(`Engine unhealthy: HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getVersion(socketPath: string): Promise<string> {
  if (!existsSync(socketPath)) {
    throw new Error("Engine socket not found");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS);

  try {
    const url = `http://localhost/version`;
    const response = await fetch(url, {
      unix: socketPath,
      signal: controller.signal,
    } as RequestInit);

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }

    const body = (await response.json()) as VersionResponse;
    return body.version;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Engine timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildCheckRequestBody(opts: PostCheckOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    workspace_id: opts.workspaceId,
    workspace_root: opts.workspaceRoot,
  };
  if (opts.packageScope) {
    body.package_scope = opts.packageScope;
  }
  if (opts.deopt) {
    body.deopt = true;
  }
  return body;
}

async function executeCheckRequest(socketPath: string, body: Record<string, unknown>): Promise<CheckResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch("http://localhost/check", {
      unix: socketPath,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    } as RequestInit);

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }
    return (await response.json()) as CheckResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Check timeout (10 minutes exceeded)");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function postCheck(opts: PostCheckOptions): Promise<CheckResponse> {
  if (!existsSync(opts.socketPath)) {
    throw new Error("Engine socket not found");
  }
  const body = buildCheckRequestBody(opts);
  return executeCheckRequest(opts.socketPath, body);
}
