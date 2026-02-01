import { describe, expect, test } from "bun:test";
import { parseCheckArgs } from "./args.js";

describe("parseCheckArgs", () => {
  test("returns defaults when no flags provided", () => {
    const result = parseCheckArgs(["check"]);
    expect(result).toEqual({ packageScope: null, deopt: false });
  });

  test("parses --deopt flag", () => {
    const result = parseCheckArgs(["check", "--deopt"]);
    expect(result).toEqual({ packageScope: null, deopt: true });
  });

  test("parses --package with space-separated value", () => {
    const result = parseCheckArgs(["check", "--package", "packages/auth"]);
    expect(result.packageScope).toBe("packages/auth");
  });

  test("parses -p short form", () => {
    const result = parseCheckArgs(["check", "-p", "packages/auth"]);
    expect(result.packageScope).toBe("packages/auth");
  });

  test("parses --package=value form", () => {
    const result = parseCheckArgs(["check", "--package=packages/auth"]);
    expect(result.packageScope).toBe("packages/auth");
  });

  test("parses both -p and --deopt together", () => {
    const result = parseCheckArgs(["check", "-p", "pkg/a", "--deopt"]);
    expect(result.packageScope).toBe("pkg/a");
    expect(result.deopt).toBe(true);
  });

  test("parses --deopt before --package", () => {
    const result = parseCheckArgs(["check", "--deopt", "--package", "pkg/a"]);
    expect(result.packageScope).toBe("pkg/a");
    expect(result.deopt).toBe(true);
  });

  test("throws when --package has no value", () => {
    expect(() => parseCheckArgs(["check", "--package"])).toThrow(
      "--package requires a value"
    );
  });

  test("throws when --package= has empty value", () => {
    expect(() => parseCheckArgs(["check", "--package="])).toThrow(
      "--package requires a value"
    );
  });

  test("throws when -p has no value", () => {
    expect(() => parseCheckArgs(["check", "-p"])).toThrow(
      "-p requires a value"
    );
  });

  test("throws when -p is followed by a flag", () => {
    expect(() => parseCheckArgs(["check", "-p", "--deopt"])).toThrow(
      "-p requires a value"
    );
  });

  test("handles nested scope paths", () => {
    const result = parseCheckArgs(["check", "-p", "packages/nested/deep"]);
    expect(result.packageScope).toBe("packages/nested/deep");
  });

  test("handles scoped npm package names", () => {
    const result = parseCheckArgs(["check", "-p", "@scope/pkg"]);
    expect(result.packageScope).toBe("@scope/pkg");
  });
});
