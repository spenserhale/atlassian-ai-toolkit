import {
  AtlassianConfigSchema,
  AtlassianErrorResponseSchema,
  ConfluenceAttachmentUploadResultSchema,
  ConfluencePageSchema,
  JiraAttachmentListSchema,
  JiraIssueSchema,
  JiraSprintListSchema,
  JiraSprintSchema,
} from "./types.js";
import type {
  AtlassianConfig,
  ConfluenceAttachmentUploadInput,
  ConfluenceAttachmentUploadResult,
  ConfluencePage,
  CreateJiraSprintInput,
  JiraAttachment,
  JiraIssue,
  JiraSprint,
  JiraSprintList,
  JiraSprintListOptions,
  MoveJiraSprintIssuesInput,
  UpdateJiraSprintInput,
} from "./types.js";
import { guessContentType } from "./content-type.js";
import {
  AtlassianAuthError,
  AtlassianError,
  AtlassianNotFoundError,
  AtlassianRateLimitError,
} from "./errors.js";

type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  readonly body?: BodyInit | unknown;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, QueryValue>;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

/** One file to upload. `data` is raw bytes or text; `contentType` defaults to a guess from `filename`. */
export interface JiraAttachmentUpload {
  readonly filename: string;
  readonly data: Blob | ArrayBuffer | Uint8Array | string;
  readonly contentType?: string;
}

function toBlobPart(data: ArrayBuffer | Uint8Array | string): BlobPart {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  // Blob rejects views backed by a SharedArrayBuffer. Re-view the same bytes when it is a plain
  // ArrayBuffer (no copy), and fall back to copying only for shared memory.
  return data.buffer instanceof ArrayBuffer
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

function toBlob(file: JiraAttachmentUpload): Blob {
  if (file.data instanceof Blob) return file.data;
  return new Blob([toBlobPart(file.data)], { type: file.contentType ?? guessContentType(file.filename) });
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
    const isFormData = opts.body instanceof FormData;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.authHeader(),
      // Atlassian rejects multipart uploads without this XSRF opt-out header. Content-Type is
      // left unset for them so fetch can add the multipart boundary itself.
      ...(isFormData ? { "X-Atlassian-Token": "no-check" } : {}),
      ...opts.headers,
    };
    if (opts.body !== undefined && !isFormData) headers["Content-Type"] = "application/json";

    const res = await fetch(this.buildUrl(path, opts.query), {
      method,
      headers,
      body: isFormData ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

  async getJiraSprint(sprintId: string | number): Promise<JiraSprint> {
    const data = await this.request<unknown>("GET", `/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}`);
    return JiraSprintSchema.parse(data);
  }

  async listJiraSprints(boardId: string | number, opts: JiraSprintListOptions = {}): Promise<JiraSprintList> {
    const data = await this.request<unknown>("GET", `/rest/agile/1.0/board/${encodeURIComponent(String(boardId))}/sprint`, {
      query: { state: opts.state },
    });
    return JiraSprintListSchema.parse(data);
  }

  async createJiraSprint(input: CreateJiraSprintInput): Promise<JiraSprint> {
    const data = await this.request<unknown>("POST", "/rest/agile/1.0/sprint", { body: input });
    return JiraSprintSchema.parse(data);
  }

  async updateJiraSprint(sprintId: string | number, input: UpdateJiraSprintInput): Promise<JiraSprint> {
    const data = await this.request<unknown>("POST", `/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}`, { body: input });
    return JiraSprintSchema.parse(data);
  }

  async moveJiraSprintIssues(input: MoveJiraSprintIssuesInput): Promise<void> {
    const path = "targetSprintId" in input
      ? `/rest/agile/1.0/sprint/${encodeURIComponent(String(input.targetSprintId))}/issue`
      : "/rest/agile/1.0/backlog/issue";

    await this.request<void>("POST", path, { body: { issues: input.issueKeys } });
  }

  async addJiraAttachments(
    issueIdOrKey: string,
    files: readonly JiraAttachmentUpload[]
  ): Promise<JiraAttachment[]> {
    if (files.length === 0) {
      throw new AtlassianError("At least one file is required to upload an attachment", "NO_FILES", 400, null);
    }

    const body = new FormData();
    for (const file of files) body.append("file", toBlob(file), file.filename);

    const data = await this.request<unknown>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/attachments`,
      { body }
    );
    return JiraAttachmentListSchema.parse(data);
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

  async uploadConfluenceAttachment(pageId: string, input: ConfluenceAttachmentUploadInput): Promise<ConfluenceAttachmentUploadResult> {
    const validPageId = requireNonEmpty(pageId, "pageId");
    const filename = requireNonEmpty(input.filename, "filename");
    const body = new FormData();
    body.set("file", input.file, filename);
    body.set("minorEdit", String(input.minorEdit ?? true));
    if (input.comment !== undefined) body.set("comment", input.comment);

    const data = await this.request<unknown>(
      input.createOnly ? "POST" : "PUT",
      `/wiki/rest/api/content/${encodeURIComponent(validPageId)}/child/attachment`,
      {
        body,
        headers: { "X-Atlassian-Token": "nocheck" },
      }
    );
    return ConfluenceAttachmentUploadResultSchema.parse(data);
  }
}
