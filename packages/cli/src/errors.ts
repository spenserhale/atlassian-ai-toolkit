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

/** The structured form of a failure, shared by every command so `--json` errors look the same everywhere. */
export function errorPayload(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof UsageError ? "usage_error" : errorCode(err);
  const details = err instanceof AtlassianError && !(err instanceof AtlassianConfigError) ? err.details : undefined;
  const hint = err instanceof UsageError || err instanceof AtlassianConfigError ? err.hint : undefined;
  const reason = err instanceof AtlassianConfigError ? err.reason : undefined;
  const validValues = err instanceof UsageError ? err.validValues : undefined;
  return { status: "error", code, message, details, reason, valid_values: validValues, hint };
}

/**
 * Prints a failure and exits non-zero: 2 for usage errors, 3 for config errors, 1 otherwise. With
 * `--json` the failure goes to stdout so agents can parse it; field errors carry their recovery data
 * (issue types, required fields, settable fields, allowed values, conflicting versions) in `details`.
 */
export function handleError(err: unknown, json: boolean): never {
  const payload = errorPayload(err);
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(`error: ${String(payload.message)}`);
    if (payload.reason) console.error(`reason: ${String(payload.reason)}`);
    if (payload.details !== undefined && payload.details !== null) console.error(`details: ${JSON.stringify(payload.details)}`);
    if (Array.isArray(payload.valid_values)) console.error(`valid values: ${payload.valid_values.join(", ")}`);
    if (payload.hint) console.error(`hint: ${String(payload.hint)}`);
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
    handleError(err, json);
  }
}
