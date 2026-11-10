export class AtlassianError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AtlassianError";
  }
}

export class AtlassianAuthError extends AtlassianError {
  constructor(message = "Authentication failed. Check ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN.") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AtlassianAuthError";
  }
}

export class AtlassianNotFoundError extends AtlassianError {
  constructor(message = "Resource not found.") {
    super(message, "NOT_FOUND", 404);
    this.name = "AtlassianNotFoundError";
  }
}

export class AtlassianRateLimitError extends AtlassianError {
  constructor(
    message = "Atlassian rate limit exceeded. Retry after the indicated delay.",
    public readonly retryAfter?: number
  ) {
    super(message, "RATE_LIMITED", 429);
    this.name = "AtlassianRateLimitError";
  }
}

/**
 * A field edit rejected before it reached Jira. `details` carries what the caller needs to recover
 * (the issue's settable fields, or a field's allowed values) rather than leaving them to retry blind.
 */
export class AtlassianFieldError extends AtlassianError {
  constructor(message: string, code: string, details?: unknown) {
    super(message, code, 400, details);
    this.name = "AtlassianFieldError";
  }
}

/**
 * Configuration the toolkit cannot work with, such as an unreachable OS keychain. `hint` says how to
 * fix it; the CLI maps this error to exit code 3.
 */
export class AtlassianConfigError extends AtlassianError {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly reason?: string
  ) {
    super(message, "CONFIG_ERROR", undefined, reason === undefined ? undefined : { reason });
    this.name = "AtlassianConfigError";
  }
}
