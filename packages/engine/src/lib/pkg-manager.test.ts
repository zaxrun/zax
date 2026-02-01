import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import {
  detectPackageManager,
  getRunnerCommand,
  getInstallCommand,
  buildVitestCommand,
  buildEslintCommand,
  preFlightCheck,
  RUNNER_COMMANDS,
  INSTALL_COMMANDS,
  LOCKFILE_PRIORITY,
  type PackageManager
} from "./pkg-manager.js";
import { CheckError } from "./errors.js";

describe("pkg-manager module", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = join(tmpdir(), `zax-pkg-test-${Date.now()}-${Math.random()}`);
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("detectPackageManager", () => {
    test("detects bun when bun.lockb exists", () => {
      writeFileSync(join(workspaceRoot, "bun.lockb"), "");
      expect(detectPackageManager(workspaceRoot)).toBe("bun");
    });

    test("detects pnpm when pnpm-lock.yaml exists", () => {
      writeFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(workspaceRoot)).toBe("pnpm");
    });

    test("detects yarn when yarn.lock exists", () => {
      writeFileSync(join(workspaceRoot, "yarn.lock"), "");
      expect(detectPackageManager(workspaceRoot)).toBe("yarn");
    });

    test("detects npm when package-lock.json exists", () => {
      writeFileSync(join(workspaceRoot, "package-lock.json"), "");
      expect(detectPackageManager(workspaceRoot)).toBe("npm");
    });

    test("defaults to npm when no lockfile exists", () => {
      expect(detectPackageManager(workspaceRoot)).toBe("npm");
    });

    test("respects priority order (bun > pnpm)", () => {
      writeFileSync(join(workspaceRoot, "bun.lockb"), "");
      writeFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(workspaceRoot)).toBe("bun");
    });

    test("respects priority order (pnpm > yarn)", () => {
      writeFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "");
      writeFileSync(join(workspaceRoot, "yarn.lock"), "");
      expect(detectPackageManager(workspaceRoot)).toBe("pnpm");
    });

    test("respects priority order (yarn > npm)", () => {
      writeFileSync(join(workspaceRoot, "yarn.lock"), "");
      writeFileSync(join(workspaceRoot, "package-lock.json"), "");
      expect(detectPackageManager(workspaceRoot)).toBe("yarn");
    });
  });

  describe("getRunnerCommand", () => {
    test("returns correct command for npm", () => {
      expect(getRunnerCommand("npm")).toEqual(RUNNER_COMMANDS.npm);
    });

    test("returns correct command for pnpm", () => {
      expect(getRunnerCommand("pnpm")).toEqual(RUNNER_COMMANDS.pnpm);
    });

    test("returns correct command for yarn", () => {
      expect(getRunnerCommand("yarn")).toEqual(RUNNER_COMMANDS.yarn);
    });

    test("returns correct command for bun", () => {
      expect(getRunnerCommand("bun")).toEqual(RUNNER_COMMANDS.bun);
    });
  });

  describe("getInstallCommand", () => {
    test("returns correct command for npm", () => {
      expect(getInstallCommand("npm")).toEqual(INSTALL_COMMANDS.npm);
    });

    test("returns correct command for pnpm", () => {
      expect(getInstallCommand("pnpm")).toEqual(INSTALL_COMMANDS.pnpm);
    });

    test("returns correct command for yarn", () => {
      expect(getInstallCommand("yarn")).toEqual(INSTALL_COMMANDS.yarn);
    });

    test("returns correct command for bun", () => {
      expect(getInstallCommand("bun")).toEqual(INSTALL_COMMANDS.bun);
    });
  });
  
  describe("Property C1: Lockfile Priority Ordering", () => {
    test("highest priority lockfile always wins", () => {
      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        // Clear directory for this iteration
         try {
          rmSync(workspaceRoot, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
        mkdirSync(workspaceRoot, { recursive: true });

        // Randomly decide which lockfiles to create
        const presentLockfiles: { file: string; pm: PackageManager; index: number }[] = [];
        
        LOCKFILE_PRIORITY.forEach((item, index) => {
          if (Math.random() > 0.5) {
             writeFileSync(join(workspaceRoot, item.file), "");
             presentLockfiles.push({ ...item, index });
          }
        });

        const detected = detectPackageManager(workspaceRoot);

        if (presentLockfiles.length === 0) {
          expect(detected).toBe("npm");
        } else {
          // Find the one with lowest index (highest priority)
          const expected = presentLockfiles.reduce((prev, curr) => 
            curr.index < prev.index ? curr : prev
          );
          expect(detected).toBe(expected.pm);
        }
      }
    });
  });

  describe("buildVitestCommand", () => {
    test("includes runner prefix", () => {
       const cmd = buildVitestCommand("pnpm", "out.json");
       expect(cmd.slice(0, 2)).toEqual(["pnpm", "exec"]);
    });

    test("includes vitest run arguments", () => {
       const cmd = buildVitestCommand("npm", "out.json");
       expect(cmd).toContain("vitest");
       expect(cmd).toContain("run");
       expect(cmd).toContain("--reporter=json");
       expect(cmd).toContain("--outputFile=out.json");
    });

    test("includes test files if provided", () => {
       const cmd = buildVitestCommand("npm", "out.json", ["test1.ts", "test2.ts"]);
       expect(cmd).toContain("test1.ts");
       expect(cmd).toContain("test2.ts");
    });
  });

  describe("buildEslintCommand", () => {
    test("includes runner prefix", () => {
       const cmd = buildEslintCommand("yarn", "out.json");
       expect(cmd.slice(0, 2)).toEqual(["yarn", "exec"]);
    });

    test("includes eslint arguments", () => {
       const cmd = buildEslintCommand("npm", "out.json");
       expect(cmd).toContain("eslint");
       expect(cmd).toContain("-f");
       expect(cmd).toContain("json");
       expect(cmd).toContain("-o");
       expect(cmd).toContain("out.json");
       expect(cmd).toContain(".");
    });

    test("defaults to '.' when no targetPath provided", () => {
       const cmd = buildEslintCommand("npm", "out.json");
       expect(cmd[cmd.length - 1]).toBe(".");
    });

    test("uses targetPath instead of '.' when provided", () => {
       const cmd = buildEslintCommand("npm", "out.json", "packages/auth");
       expect(cmd[cmd.length - 1]).toBe("packages/auth");
       expect(cmd).not.toContain(".");
    });

    test("targetPath works for all package managers", () => {
       const pms: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
       pms.forEach(pm => {
          const cmd = buildEslintCommand(pm, "out.json", "packages/auth");
          expect(cmd[cmd.length - 1]).toBe("packages/auth");
       });
    });
  });

  describe("preFlightCheck", () => {
    test("throws DEPS_NOT_INSTALLED if node_modules missing", () => {
      // workspaceRoot is empty initially in beforeEach
      try {
        preFlightCheck(workspaceRoot, "npm");
        expect(true).toBe(false); // Should not reach here
      } catch (e: unknown) {
        if (e instanceof CheckError) {
          expect(e.code).toBe("DEPS_NOT_INSTALLED");
          expect(e.message).toContain(INSTALL_COMMANDS.npm);
        } else {
          throw e;
        }
      }
    });

    test("does not throw if node_modules exists", () => {
      mkdirSync(join(workspaceRoot, "node_modules"));
      expect(() => preFlightCheck(workspaceRoot, "npm")).not.toThrow();
    });
  });

  describe("Property C3/C4: Command Builders", () => {
    test("commands always start with runner prefix", () => {
       const pms: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
       pms.forEach(pm => {
          const vCmd = buildVitestCommand(pm, "o");
          const eCmd = buildEslintCommand(pm, "o");
          const prefix = RUNNER_COMMANDS[pm];
          
          expect(vCmd.slice(0, prefix.length)).toEqual(prefix);
          expect(eCmd.slice(0, prefix.length)).toEqual(prefix);
       });
    });

    test("commands preserve arguments", () => {
       const pms: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
       pms.forEach(pm => {
          const vCmd = buildVitestCommand(pm, "out.json", ["t1"]);
          expect(vCmd).toContain("--outputFile=out.json");
          expect(vCmd).toContain("t1");

          const eCmd = buildEslintCommand(pm, "out.json");
          expect(eCmd).toContain("-o");
          expect(eCmd).toContain("out.json");
       });
    });
  });
});
