import {
  AtlassianAuthError,
  AtlassianError,
  AtlassianFieldError,
  AtlassianNotFoundError,
  AtlassianRateLimitError,
} from "@atlassian-ai-toolkit/sdk";

/** The snake_case code callers branch on, rather than the error message text. */
export function errorCode(err: unknown): string {
  if (err instanceof AtlassianFieldError) return err.code;
  if (err instanceof AtlassianAuthError) return "auth_error";
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
  process.exit(1);
}
