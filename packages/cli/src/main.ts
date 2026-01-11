import { existsSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeWorkspaceId, getCacheDir, ensureCacheDir } from "./lib/workspace.js";
import { connectToEngine, getVersion } from "./lib/engine-client.js";

const SOCKET_WAIT_TIMEOUT_MS = 10000;
const SOCKET_POLL_INTERVAL_MS = 100;

function printUsage(): void {
  console.log("Usage: zx [options] [command]");
  console.log("");
  console.log("Options:");
  console.log("  -v, --version    Print version");
  console.log("  -h, --help       Print help");
}

function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

function getEnginePath(): string {
  const thisFile = new URL(import.meta.url).pathname;
  const srcDir = resolve(thisFile, "..");
  const repoRoot = resolve(srcDir, "../../..");
  return join(repoRoot, "packages/engine/src/main.ts");
}

async function waitForSocket(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + SOCKET_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
  }

  return false;
}

function acquireLock(lockPath: string): number {
  writeFileSync(lockPath, "", { mode: 0o600 });
  const fd = openSync(lockPath, "r");
  return fd;
}

function releaseLock(fd: number): void {
  closeSync(fd);
}

async function spawnEngine(cacheDir: string): Promise<void> {
  const enginePath = getEnginePath();

  Bun.spawn(["bun", "run", enginePath, cacheDir], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function ensureEngine(cacheDir: string): Promise<string> {
  const socketPath = join(cacheDir, "zax.sock");
  const lockPath = join(cacheDir, "engine.lock");

  const fd = acquireLock(lockPath);

  try {
    if (existsSync(socketPath)) {
      try {
        await connectToEngine(socketPath);
        return socketPath;
      } catch {
        unlinkSync(socketPath);
      }
    }

    await spawnEngine(cacheDir);

    const found = await waitForSocket(socketPath);
    if (!found) {
      throw new Error("Engine failed to start");
    }

    return socketPath;
  } finally {
    releaseLock(fd);
  }
}

async function handleVersion(cacheDir: string): Promise<void> {
  try {
    const socketPath = await ensureEngine(cacheDir);
    const version = await getVersion(socketPath);
    console.log(`zax ${version}`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("connection")) {
      printError("Engine connection failed");
    } else {
      printError(message);
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  const workspaceId = computeWorkspaceId(cwd);
  const cacheDir = getCacheDir(workspaceId);

  try {
    ensureCacheDir(cacheDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(message);
    process.exit(1);
  }

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const arg = args[0];

  if (arg === "--version" || arg === "-v") {
    await handleVersion(cacheDir);
    return;
  }

  if (arg === "--help" || arg === "-h") {
    printUsage();
    process.exit(0);
  }

  printError(`Unknown option: ${arg}`);
  process.exit(1);
}

main();
