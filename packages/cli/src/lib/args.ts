export interface CheckArgs {
  packageScope: string | null;
  deopt: boolean;
}

/** Parse check-subcommand flags from argv (after "check" is consumed). */
export function parseCheckArgs(args: readonly string[]): CheckArgs {
  let packageScope: string | null = null;
  let deopt = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--deopt") {
      deopt = true;
      continue;
    }

    if (arg === "--package" || arg === "-p") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a value`);
      }
      packageScope = value;
      i++;
      continue;
    }

    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length);
      if (value === "") {
        throw new Error("--package requires a value");
      }
      packageScope = value;
      continue;
    }
  }

  return { packageScope, deopt };
}
