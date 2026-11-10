import {
  AtlassianAuthError,
  AtlassianConfigError,
  AtlassianError,
  AtlassianFieldError,
  AtlassianNotFoundError,
  AtlassianRateLimitError,
} from "@atlassian-ai-toolkit/sdk";

/** The snake_case code callers branch on, rather than the error message text. */
export function errorCode(err: unknown): string {
  if (err instanceof AtlassianFieldError) return err.code;
  if (err instanceof AtlassianAuthError) return "auth_error";
  if (err instanceof AtlassianConfigError) return "config_error";
  if (err instanceof AtlassianNotFoundError) return "not_found";
  if (err instanceof AtlassianRateLimitError) return "rate_limited";
  if (err instanceof AtlassianError) return "upstream_error";
  return "usage_error";
}

/**
 * Prints a failure and exits non-zero. Field errors carry the recovery data (issue types, required
 * fields, settable fields, allowed values), so the details ride along with the code.
 */
export function handleError(err: unknown, json: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.log(JSON.stringify({ status: "error", code: errorCode(err), message, details: err instanceof AtlassianError ? err.details : undefined }, null, 2));
  } else {
    console.error(`error: ${message}`);
    if (err instanceof AtlassianError && err.details !== undefined && err.details !== null) {
      console.error(`details: ${JSON.stringify(err.details)}`);
    }
  }
  process.exit(exitCodeFor(err));
}

/** Bad input the caller can fix by changing the command. Exits 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly validValues?: readonly string[]
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/** Exit codes: 1 for runtime and upstream failures, 2 for usage errors, 3 for config errors. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return 2;
  if (err instanceof AtlassianConfigError) return 3;
  return 1;
}

/**
 * Runs a command body with enumerated exit codes. Errors go to stdout as JSON with `--json` so agents
 * can parse them, otherwise to stderr with the hint on its own line.
 */
export async function runCommand(json: boolean, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = err instanceof UsageError || err instanceof AtlassianConfigError ? err.hint : undefined;
    const validValues = err instanceof UsageError ? err.validValues : undefined;
    const reason = err instanceof AtlassianConfigError ? err.reason : undefined;
    const code = err instanceof UsageError ? "usage_error" : err instanceof AtlassianConfigError ? "config_error" : errorCode(err);
    if (json) {
      console.log(JSON.stringify({ status: "error", code, message, reason, valid_values: validValues, hint }, null, 2));
    } else {
      console.error(`error: ${message}`);
      if (reason) console.error(`reason: ${reason}`);
      if (validValues) console.error(`valid values: ${validValues.join(", ")}`);
      if (hint) console.error(`hint: ${hint}`);
    }
    process.exit(exitCodeFor(err));
  }
}
