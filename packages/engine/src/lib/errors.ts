export type CheckErrorCode =
  | "CONCURRENT_CHECK" | "VITEST_NOT_FOUND" | "VITEST_TIMEOUT"
  | "VITEST_FAILED" | "PARSE_ERROR" | "RPC_TIMEOUT" | "INTERNAL"
  | "DEPS_NOT_INSTALLED";

export class CheckError extends Error {
  code: CheckErrorCode;
  constructor(code: CheckErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "CheckError";
  }
}
