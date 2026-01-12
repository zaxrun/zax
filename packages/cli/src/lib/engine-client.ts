import { existsSync } from "node:fs";

interface VersionResponse {
  version: string;
}

interface CheckResponse {
  new_test_failures: number;
  fixed_test_failures: number;
}

interface ErrorResponse {
  error: string;
}

export async function connectToEngine(socketPath: string): Promise<Response> {
  const url = `http://localhost/health`;
  return fetch(url, { unix: socketPath } as RequestInit);
}

export async function getVersion(socketPath: string): Promise<string> {
  if (!existsSync(socketPath)) {
    throw new Error("Engine socket not found");
  }

  const url = `http://localhost/version`;
  const response = await fetch(url, { unix: socketPath } as RequestInit);

  if (!response.ok) {
    const body = (await response.json()) as ErrorResponse;
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  const body = (await response.json()) as VersionResponse;
  return body.version;
}

export async function postCheck(
  socketPath: string,
  workspaceId: string,
  workspaceRoot: string
): Promise<CheckResponse> {
  if (!existsSync(socketPath)) {
    throw new Error("Engine socket not found");
  }

  const url = `http://localhost/check`;
  const response = await fetch(url, {
    unix: socketPath,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, workspace_root: workspaceRoot }),
  } as RequestInit);

  if (!response.ok) {
    const body = (await response.json()) as ErrorResponse;
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  return (await response.json()) as CheckResponse;
}
