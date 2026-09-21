import {
  AtlassianConfigSchema,
  AtlassianErrorResponseSchema,
  DEFAULT_JIRA_STORY_POINTS_FIELD,
  JiraApproximateCountSchema,
  JiraIssueEditMetaSchema,
  ConfluenceAttachmentUploadResultSchema,
  ConfluencePageSchema,
  JiraAttachmentListSchema,
  JiraIssueSchema,
  JiraSearchPageSchema,
  JiraSprintIssuePageSchema,
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
  JiraFieldEdits,
  JiraIssue,
  JiraIssueEditBatchResult,
  JiraIssueEditEntry,
  JiraIssueEditMeta,
  JiraIssueEditOptions,
  JiraIssueEditResult,
  JiraIssueFieldEdits,
  JiraSearchOptions,
  JiraSearchResult,
  JiraSprint,
  JiraSprintIssueList,
  JiraSprintIssueListOptions,
  JiraSprintIssueMoveResult,
  JiraSprintList,
  JiraSprintListOptions,
  JiraSprintPoints,
  JiraSprintPointsOptions,
  MoveJiraSprintIssuesInput,
  UpdateJiraSprintInput,
} from "./types.js";
import { guessContentType } from "./content-type.js";
import { planJiraIssueFieldEdits } from "./jira-fields.js";
import {
  AtlassianAuthError,
  AtlassianError,
  AtlassianFieldError,
  AtlassianNotFoundError,
  AtlassianRateLimitError,
} from "./errors.js";

type QueryValue = string | number | boolean | undefined;

/** Jira's agile API rejects sprint issue moves with more than this many issue keys in one request. */
export const JIRA_SPRINT_ISSUE_MOVE_LIMIT = 50;

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

/** Per-key batch codes, in the snake_case shape the CLI and MCP report errors in. */
function editFailureCode(err: unknown): string {
  if (err instanceof AtlassianFieldError) return err.code;
  if (err instanceof AtlassianAuthError) return "auth_error";
  if (err instanceof AtlassianNotFoundError) return "not_found";
  if (err instanceof AtlassianRateLimitError) return "rate_limited";
  if (err instanceof AtlassianError) return "upstream_error";
  return "unknown_error";
}

/** Jira allows fractional points, and repeated float addition drifts. */
function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

function isDoneIssue(issue: JiraIssue): boolean {
  const status = issue.fields?.status;
  if (typeof status !== "object" || status === null) return false;
  const category = (status as { statusCategory?: unknown }).statusCategory;
  if (typeof category !== "object" || category === null) return false;
  return (category as { key?: unknown }).key === "done";
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

  /**
   * Jira's enhanced search pages by token and reports no total of its own. This is the only source
   * for one, and the count is approximate by name.
   */
  async countJiraIssues(jql: string): Promise<number> {
    const query = requireNonEmpty(jql, "jql");
    const data = await this.request<unknown>("POST", "/rest/api/3/search/approximate-count", { body: { jql: query } });
    return JiraApproximateCountSchema.parse(data).count;
  }

  /**
   * Runs a JQL search, walking every page unless `limit` stops it early. `isLast` reports whether
   * the walk saw the whole result set, so a truncated answer is detectable rather than inferred;
   * `total` is exact when it did and Jira's approximate count when it did not.
   */
  async searchJiraIssues(jql: string, opts: JiraSearchOptions = {}): Promise<JiraSearchResult> {
    const query = requireNonEmpty(jql, "jql");
    const maxResults = opts.maxResults ?? 100;
    const fields = opts.fields !== undefined && opts.fields.length > 0 ? [...opts.fields] : ["*navigable"];
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    let exhausted = false;

    for (;;) {
      const data = await this.request<unknown>("POST", "/rest/api/3/search/jql", {
        body: { jql: query, maxResults, fields, nextPageToken },
      });
      const page = JiraSearchPageSchema.parse(data);
      issues.push(...page.issues);
      nextPageToken = page.nextPageToken;
      if (nextPageToken === undefined || page.isLast === true || page.issues.length === 0) {
        exhausted = true;
        break;
      }
      if (opts.limit !== undefined && issues.length >= opts.limit) break;
    }

    const limited = opts.limit !== undefined ? issues.slice(0, opts.limit) : issues;
    const isLast = exhausted && limited.length === issues.length;
    return {
      issues: limited,
      total: isLast ? limited.length : await this.countJiraIssues(query),
      isLast,
      startAt: 0,
      maxResults,
    };
  }

  async getJiraIssueEditMeta(issueIdOrKey: string): Promise<JiraIssueEditMeta> {
    const data = await this.request<unknown>("GET", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/editmeta`);
    return JiraIssueEditMetaSchema.parse(data);
  }

  /**
   * Sets fields on one issue. Field ids or display names are resolved against the issue's edit
   * screen and values are coerced to the shape each field's schema requires, so callers do not have
   * to know that a single-select wants `{value}` while a number wants a bare number.
   * `dryRun` returns the resolved body without sending it.
   */
  async editJiraIssue(issueIdOrKey: string, edits: JiraFieldEdits, opts: JiraIssueEditOptions = {}): Promise<JiraIssueEditResult> {
    const meta = await this.getJiraIssueEditMeta(issueIdOrKey);
    const plan = planJiraIssueFieldEdits(meta, edits);

    if (opts.dryRun === true) return { key: issueIdOrKey, status: "dry_run", ...plan };

    await this.request<void>("PUT", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, {
      body: { fields: plan.fields },
      query: { notifyUsers: opts.notifyUsers },
    });
    return { key: issueIdOrKey, status: "updated", ...plan };
  }

  /**
   * Applies field edits across several issues, reporting per key and continuing past failures so one
   * issue type that cannot take a field does not strand the rest of a batch of audit corrections.
   */
  async editJiraIssues(edits: readonly JiraIssueFieldEdits[], opts: JiraIssueEditOptions = {}): Promise<JiraIssueEditBatchResult> {
    if (edits.length === 0) throw new AtlassianFieldError("Provide at least one issue to edit", "field_required");

    const results: JiraIssueEditEntry[] = [];
    for (const edit of edits) {
      try {
        results.push(await this.editJiraIssue(edit.key, edit.fields, opts));
      } catch (err) {
        results.push({
          key: edit.key,
          status: "error",
          code: editFailureCode(err),
          message: err instanceof Error ? err.message : String(err),
          details: err instanceof AtlassianError ? err.details : undefined,
        });
      }
    }

    return {
      updated: results.filter((result) => result.status !== "error").length,
      failed: results.filter((result) => result.status === "error").length,
      results,
    };
  }

  async getJiraSprint(sprintId: string | number): Promise<JiraSprint> {
    const data = await this.request<unknown>("GET", `/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}`);
    return JiraSprintSchema.parse(data);
  }

  async listJiraSprints(boardId?: string | number, opts: JiraSprintListOptions = {}): Promise<JiraSprintList> {
    const path = `/rest/agile/1.0/board/${encodeURIComponent(String(this.resolveBoardId(boardId)))}/sprint`;
    const maxResults = opts.maxResults ?? 50;
    const values: JiraSprint[] = [];
    let startAt = 0;
    let total: number | undefined;

    for (;;) {
      const data = await this.request<unknown>("GET", path, {
        query: { state: opts.state, startAt, maxResults },
      });
      const page = JiraSprintListSchema.parse(data);
      values.push(...page.values);
      total = page.total;
      // Jira's agile endpoints are expected to send isLast, but fall back to a short-page check
      // in case a board's sprint list ever omits it, so this can't loop forever.
      if (page.isLast === true || page.values.length === 0 || page.values.length < maxResults) break;
      if (total !== undefined && values.length >= total) break;
      startAt += page.values.length;
    }

    return { values, total: total ?? values.length, isLast: true, startAt: 0, maxResults };
  }

  /**
   * Resolves a board-scoped argument against the configured default board, so callers can omit the
   * board id once `ATLASSIAN_JIRA_BOARD_ID` (or the constructor config) names one.
   */
  private resolveBoardId(boardId: string | number | undefined): string | number {
    const board = boardId ?? this.config.jiraBoardId;
    if (board === undefined) throw new Error("boardId is required; pass a board id or set ATLASSIAN_JIRA_BOARD_ID");
    return board;
  }

  /**
   * Returns the sprint currently running on a board. A board running parallel sprints reports
   * several active sprints; the earliest-started one is the current sprint. Throws when the board
   * has no active sprint.
   */
  async getCurrentJiraSprint(boardId?: string | number): Promise<JiraSprint> {
    const list = await this.listJiraSprints(this.resolveBoardId(boardId), { state: "active" });
    // Jira start dates are ISO 8601, so lexicographic order is chronological; sprints without a
    // start date sort last rather than masquerading as the oldest.
    const current = [...list.values].sort((a, b) => (a.startDate ?? "\uffff").localeCompare(b.startDate ?? "\uffff"))[0];
    if (current === undefined) {
      throw new AtlassianError(`Board ${boardId ?? this.config.jiraBoardId} has no active sprint`, "NO_ACTIVE_SPRINT", 404);
    }
    return current;
  }

  async listJiraSprintIssues(sprintId: string | number, opts: JiraSprintIssueListOptions = {}): Promise<JiraSprintIssueList> {
    const path = `/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}/issue`;
    const maxResults = opts.maxResults ?? 50;
    const fields = opts.fields !== undefined && opts.fields.length > 0 ? opts.fields.join(",") : undefined;
    const issues: JiraIssue[] = [];
    let startAt = 0;
    let total: number | undefined;

    for (;;) {
      const data = await this.request<unknown>("GET", path, {
        query: { startAt, maxResults, fields },
      });
      const page = JiraSprintIssuePageSchema.parse(data);
      issues.push(...page.issues);
      total = page.total;
      if (page.isLast === true || page.issues.length === 0) break;
      if (total !== undefined && issues.length >= total) break;
      startAt += page.issues.length;
    }

    return { total: total ?? issues.length, issues };
  }

  /**
   * Sums story points across a sprint, splitting completed from committed by status category so
   * site-specific workflow status names do not have to be configured. Costs one paginated pass over
   * the sprint, requesting only the points field and status.
   */
  async getJiraSprintPoints(sprintId: string | number, opts: JiraSprintPointsOptions = {}): Promise<JiraSprintPoints> {
    const field = opts.pointsField ?? this.config.storyPointsField ?? DEFAULT_JIRA_STORY_POINTS_FIELD;
    const list = await this.listJiraSprintIssues(sprintId, { fields: [field, "status"] });

    let committed = 0;
    let completed = 0;
    let unestimated = 0;
    for (const issue of list.issues) {
      const points = issue.fields?.[field];
      if (typeof points !== "number" || !Number.isFinite(points)) {
        unestimated += 1;
        continue;
      }
      committed += points;
      if (isDoneIssue(issue)) completed += points;
    }

    return {
      field,
      committed: roundPoints(committed),
      completed: roundPoints(completed),
      issueCount: list.issues.length,
      unestimated,
    };
  }

  async createJiraSprint(input: CreateJiraSprintInput): Promise<JiraSprint> {
    const data = await this.request<unknown>("POST", "/rest/agile/1.0/sprint", {
      body: { ...input, originBoardId: Number(this.resolveBoardId(input.originBoardId)) },
    });
    return JiraSprintSchema.parse(data);
  }

  async updateJiraSprint(sprintId: string | number, input: UpdateJiraSprintInput): Promise<JiraSprint> {
    const data = await this.request<unknown>("POST", `/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}`, { body: input });
    return JiraSprintSchema.parse(data);
  }

  /**
   * Moves issues into a sprint or the backlog, chunking into batches of at most
   * JIRA_SPRINT_ISSUE_MOVE_LIMIT since Jira's agile API rejects larger requests outright.
   * Stops at the first failing batch rather than pressing on, since the move is a set operation
   * and re-submitting the full issueKeys list after a partial failure is safe.
   */
  async moveJiraSprintIssues(input: MoveJiraSprintIssuesInput): Promise<JiraSprintIssueMoveResult> {
    const path = "targetSprintId" in input
      ? `/rest/agile/1.0/sprint/${encodeURIComponent(String(input.targetSprintId))}/issue`
      : "/rest/agile/1.0/backlog/issue";

    const batches: string[][] = [];
    for (let i = 0; i < input.issueKeys.length; i += JIRA_SPRINT_ISSUE_MOVE_LIMIT) {
      batches.push(input.issueKeys.slice(i, i + JIRA_SPRINT_ISSUE_MOVE_LIMIT));
    }

    let moved = 0;
    const failed: JiraSprintIssueMoveResult["failed"][number][] = [];
    for (const [batchIndex, issueKeys] of batches.entries()) {
      try {
        await this.request<void>("POST", path, { body: { issues: issueKeys } });
        moved += issueKeys.length;
      } catch (err) {
        failed.push({ batchIndex, issueKeys, error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }

    return { batches: batches.length, moved, failed };
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
