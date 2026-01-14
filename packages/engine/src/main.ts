import { existsSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { waitForPortFile, createRustClient, pingWithRetry } from "./lib/rust-client.js";
import { createEngineServer } from "./lib/server.js";
import { initLogger, log } from "./lib/logger.js";

const PORT_FILE_TIMEOUT_MS = 10000;
const RETRY_DELAYS = [500, 1000, 2000];
const RUST_SHUTDOWN_TIMEOUT_MS = 2000;

let cacheDir = "";

function getLogPath(): string {
  return join(cacheDir, "engine.log");
}

function getRustBinaryPath(): string {
  const thisFile = new URL(import.meta.url).pathname;
  const srcDir = resolve(thisFile, "..");
  const repoRoot = resolve(srcDir, "../../..");
  return join(repoRoot, "crates/target/debug/zax_workspace_service");
}

async function spawnRustService(): Promise<Subprocess> {
  const binaryPath = getRustBinaryPath();
  log(`Spawning Rust service: ${binaryPath} ${cacheDir}`);

  const logFd = openSync(getLogPath(), "a");

  const proc = Bun.spawn([binaryPath, cacheDir], {
    stdout: logFd,
    stderr: logFd,
  });

  closeSync(logFd);

  return proc;
}

async function cleanup(rustProc: Subprocess): Promise<void> {
  log("Cleaning up...");

  rustProc.kill("SIGTERM");

  const deadline = Date.now() + RUST_SHUTDOWN_TIMEOUT_MS;
  while (rustProc.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (rustProc.exitCode === null) {
    log("Rust service did not exit, sending SIGKILL");
    rustProc.kill("SIGKILL");
  }

  const portFile = join(cacheDir, "rust.port");
  if (existsSync(portFile)) {
    unlinkSync(portFile);
  }

  const socketFile = join(cacheDir, "zax.sock");
  if (existsSync(socketFile)) {
    unlinkSync(socketFile);
  }

  log("Cleanup complete");
}

function writePidFile(): void {
  const pidFile = join(cacheDir, "engine.pid");
  writeFileSync(pidFile, process.pid.toString());
}

function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

/** Deletes stale port file to prevent connecting to old Rust service. */
export function cleanStalePortFile(dir: string): boolean {
  const portFile = join(dir, "rust.port");
  if (existsSync(portFile)) {
    unlinkSync(portFile);
    return true;
  }
  return false;
}

function parseArgs(): string {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    printError("cache directory argument required");
    process.exit(1);
  }
  const dir = args[0];
  if (!existsSync(dir)) {
    printError(`cache directory does not exist: ${dir}`);
    process.exit(1);
  }
  return dir;
}

async function startRustService(): Promise<{ proc: Subprocess; client: ReturnType<typeof createRustClient> }> {
  cleanStalePortFile(cacheDir);
  const proc = await spawnRustService();

  log("Waiting for port file...");
  const port = await waitForPortFile(cacheDir, PORT_FILE_TIMEOUT_MS);
  log(`Port file found: ${port}`);

  const client = createRustClient(port);
  log("Connecting to Rust service with retry...");
  await pingWithRetry(client, RETRY_DELAYS);
  log("Connected to Rust service");

  return { proc, client };
}

function setupSignalHandlers(server: ReturnType<typeof createEngineServer>, rustProc: Subprocess): void {
  const handleSignal = async (): Promise<void> => {
    log("Received shutdown signal");
    server.stop();
    await cleanup(rustProc);
    process.exit(0);
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}

async function main(): Promise<void> {
  cacheDir = parseArgs();
  initLogger(cacheDir);
  log("Engine starting...");
  writePidFile();

  let rustProc: Subprocess | undefined;
  try {
    const { proc, client } = await startRustService();
    rustProc = proc;

    const socketPath = join(cacheDir, "zax.sock");
    if (existsSync(socketPath)) { unlinkSync(socketPath); }

    const server = createEngineServer({ socketPath, cacheDir, rustClient: client });
    log(`HTTP server listening on ${socketPath}`);
    setupSignalHandlers(server, rustProc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Startup failed: ${message}`);
    printError(message);
    if (rustProc) { await cleanup(rustProc); }
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
