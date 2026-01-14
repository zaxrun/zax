import { appendFileSync } from "node:fs";
import { join } from "node:path";

let logPath: string | null = null;

export function initLogger(cacheDir: string): void {
  logPath = join(cacheDir, "engine.log");
}

export function log(message: string): void {
  if (!logPath) {
    return;
  }
  const timestamp = new Date().toISOString();
  appendFileSync(logPath, `${timestamp} ${message}\n`);
}
