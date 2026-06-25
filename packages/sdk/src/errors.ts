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
