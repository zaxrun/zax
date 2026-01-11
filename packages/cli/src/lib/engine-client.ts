import { existsSync } from "node:fs";

interface VersionResponse {
  version: string;
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
