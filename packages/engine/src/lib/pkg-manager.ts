import { existsSync } from "node:fs";
import { join } from "node:path";
import { CheckError } from "./errors.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const LOCKFILE_PRIORITY: { file: string; pm: PackageManager }[] = [
  { file: "bun.lockb", pm: "bun" },
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "yarn.lock", pm: "yarn" },
  { file: "package-lock.json", pm: "npm" },
];

export const RUNNER_COMMANDS: Record<PackageManager, string[]> = {
  npm: ["npx"],
  pnpm: ["pnpm", "exec"],
  yarn: ["yarn", "exec"],
  bun: ["bun", "x"],
};

export const INSTALL_COMMANDS: Record<PackageManager, string> = {
  npm: "npm install",
  pnpm: "pnpm install",
  yarn: "yarn install",
  bun: "bun install",
};

export function detectPackageManager(workspaceRoot: string): PackageManager {
  for (const { file, pm } of LOCKFILE_PRIORITY) {
    try {
      if (existsSync(join(workspaceRoot, file))) {
        return pm;
      }
    } catch {
      // Ignore errors (e.g., permission issues) and continue
    }
  }
  return "npm";
}

export function getRunnerCommand(pm: PackageManager): string[] {
  return RUNNER_COMMANDS[pm];
}

export function getInstallCommand(pm: PackageManager): string {
  return INSTALL_COMMANDS[pm];
}

export function buildVitestCommand(
  pm: PackageManager,
  outputFile: string,
  testFiles?: string[]
): string[] {
  const cmd = [...RUNNER_COMMANDS[pm], "vitest", "run", "--reporter=json", `--outputFile=${outputFile}`];
  if (testFiles && testFiles.length > 0) {
    cmd.push(...testFiles);
  }
  return cmd;
}

export function buildEslintCommand(
  pm: PackageManager,
  outputPath: string,
  targetPath?: string
): string[] {
  return [...RUNNER_COMMANDS[pm], "eslint", "-f", "json", "-o", outputPath, targetPath ?? "."];
}

export function preFlightCheck(workspaceRoot: string, pm: PackageManager): void {
  if (!existsSync(join(workspaceRoot, "node_modules"))) {
    throw new CheckError(
      "DEPS_NOT_INSTALLED",
      `Dependencies not installed. Run '${INSTALL_COMMANDS[pm]}' to install.`
    );
  }
}
