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
}

interface ErrorResponse {
  error: string;
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

export async function postCheck(
  socketPath: string,
  workspaceId: string,
  workspaceRoot: string
): Promise<CheckResponse> {
  if (!existsSync(socketPath)) {
    throw new Error("Engine socket not found");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const url = `http://localhost/check`;
    const response = await fetch(url, {
      unix: socketPath,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, workspace_root: workspaceRoot }),
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
