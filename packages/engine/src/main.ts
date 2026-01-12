import { existsSync, appendFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { waitForPortFile, createRustClient, pingWithRetry } from "./lib/rust-client.js";
import { createEngineServer } from "./lib/server.js";

const PORT_FILE_TIMEOUT_MS = 10000;
const RETRY_DELAYS = [500, 1000, 2000];
const RUST_SHUTDOWN_TIMEOUT_MS = 2000;

let cacheDir = "";

function getLogPath(): string {
  return join(cacheDir, "engine.log");
}

function log(message: string): void {
  const timestamp = new Date().toISOString();
  appendFileSync(getLogPath(), `${timestamp} ${message}\n`);
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

  log("Cleanup complete");
}

function writePidFile(): void {
  const pidFile = join(cacheDir, "engine.pid");
  writeFileSync(pidFile, process.pid.toString());
}

function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    printError("cache directory argument required");
    process.exit(1);
  }

  cacheDir = args[0];

  if (!existsSync(cacheDir)) {
    printError(`cache directory does not exist: ${cacheDir}`);
    process.exit(1);
  }

  log("Engine starting...");
  writePidFile();

  let rustProc: Subprocess | undefined;

  try {
    rustProc = await spawnRustService();

    log("Waiting for port file...");
    const port = await waitForPortFile(cacheDir, PORT_FILE_TIMEOUT_MS);
    log(`Port file found: ${port}`);

    const client = createRustClient(port);

    log("Connecting to Rust service with retry...");
    await pingWithRetry(client, RETRY_DELAYS);
    log("Connected to Rust service");

    const socketPath = join(cacheDir, "zax.sock");
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    const server = createEngineServer({ socketPath, cacheDir, rustClient: client });
    log(`HTTP server listening on ${socketPath}`);

    const handleSignal = async (): Promise<void> => {
      log("Received shutdown signal");
      server.stop();
      if (rustProc) {
        await cleanup(rustProc);
      }
      process.exit(0);
    };

    process.on("SIGTERM", handleSignal);
    process.on("SIGINT", handleSignal);

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Startup failed: ${message}`);
    printError(message);

    if (rustProc) {
      await cleanup(rustProc);
    }

    process.exit(1);
  }
}

main();
