import {
  AtlassianConfigSchema,
  AtlassianErrorResponseSchema,
  ConfluencePageSchema,
  JiraIssueSchema,
} from "./types.js";
import type { AtlassianConfig, ConfluencePage, JiraIssue } from "./types.js";
import {
  AtlassianAuthError,
  AtlassianError,
  AtlassianNotFoundError,
  AtlassianRateLimitError,
} from "./errors.js";

type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Record<string, QueryValue>;
}

export class AtlassianClient {
  private readonly config: AtlassianConfig;

  constructor(config: Partial<AtlassianConfig> & { siteUrl: string; email: string; apiToken: string }) {
    this.config = AtlassianConfigSchema.parse(config);
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, this.config.siteUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64")}`;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.authHeader(),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(this.buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) await this.throwForResponse(res);
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async throwForResponse(res: Response): Promise<never> {
    const raw = await res.json().catch(() => null);
    const parsed = AtlassianErrorResponseSchema.safeParse(raw);
    const message = parsed.success
      ? parsed.data.message ?? parsed.data.title ?? parsed.data.errorMessages?.join("; ") ?? `HTTP ${res.status}`
      : `HTTP ${res.status}`;
    const code = parsed.success ? parsed.data.code ?? String(res.status) : "UNKNOWN";

    if (res.status === 401 || res.status === 403) throw new AtlassianAuthError(message);
    if (res.status === 404) throw new AtlassianNotFoundError(message);
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || undefined;
      throw new AtlassianRateLimitError(message, retryAfter);
    }
    throw new AtlassianError(message, code, res.status, raw);
  }

  async getJiraIssue(issueIdOrKey: string): Promise<JiraIssue> {
    const data = await this.request<unknown>("GET", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`);
    return JiraIssueSchema.parse(data);
  }

  async deleteJiraIssue(issueIdOrKey: string, opts: { deleteSubtasks?: boolean } = {}): Promise<void> {
    await this.request<void>("DELETE", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, {
      query: { deleteSubtasks: opts.deleteSubtasks },
    });
  }

  async getConfluencePage(pageId: string): Promise<ConfluencePage> {
    const data = await this.request<unknown>("GET", `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`);
    return ConfluencePageSchema.parse(data);
  }

  async deleteConfluencePage(pageId: string, opts: { purge?: boolean } = {}): Promise<void> {
    await this.request<void>("DELETE", `/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      query: { purge: opts.purge },
    });
  }
}
