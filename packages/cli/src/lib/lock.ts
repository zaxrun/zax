import { existsSync, mkdirSync, rmdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LOCK_TIMEOUT_MS = 30000;
const LOCK_POLL_INTERVAL_MS = 100;

/** Checks if a process is still running by sending signal 0. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cleans up stale lock if the holding process is dead. */
function cleanStaleLock(lockDir: string): boolean {
  const pidFile = join(lockDir, "pid");
  if (!existsSync(pidFile)) {
    // No PID file means lock is corrupt - clean it
    try {
      rmdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!isNaN(pid) && !isProcessRunning(pid)) {
      // Accept ENOENT as success - another process may have cleaned it
      try { unlinkSync(pidFile); } catch { /* ignore */ }
      try { rmdirSync(lockDir); } catch { /* ignore */ }
      return true;
    }
  } catch {
    // Lock held by another process or race condition
  }
  return false;
}

/** Attempts to create lock directory and PID file. */
function attemptLock(lockDir: string): "acquired" | "exists" | "error" {
  try {
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(join(lockDir, "pid"), process.pid.toString());
    return "acquired";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") { return "exists"; }
    throw err;
  }
}

/** Atomically acquires lock using mkdir. Returns true if acquired. */
export function tryAcquireLock(lockDir: string): boolean {
  // Use iteration instead of recursion to avoid stack overflow on rapid contention
  const firstResult = attemptLock(lockDir);
  if (firstResult === "acquired") { return true; }
  if (firstResult === "exists" && cleanStaleLock(lockDir)) {
    // Retry once after cleaning stale lock
    return attemptLock(lockDir) === "acquired";
  }
  return false;
}

/** Releases lock by removing pid file and lock directory. */
export function releaseLock(lockDir: string): void {
  try {
    unlinkSync(join(lockDir, "pid"));
    rmdirSync(lockDir);
  } catch {
    // Best effort cleanup
  }
}

/** Acquires lock with timeout, polling until acquired or timeout. */
export async function acquireLockWithTimeout(lockDir: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (tryAcquireLock(lockDir)) { return; }
    await new Promise((r) => setTimeout(r, LOCK_POLL_INTERVAL_MS));
  }
  throw new Error("Timeout acquiring engine lock");
}
