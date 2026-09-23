import {
  AtlassianConfigSchema,
  AtlassianErrorResponseSchema,
  DEFAULT_JIRA_STORY_POINTS_FIELD,
  JiraApproximateCountSchema,
  JiraCreateMetaFieldPageSchema,
  JiraCreateMetaIssueTypePageSchema,
  JiraCreatedIssueSchema,
  JiraIssueEditMetaSchema,
  JiraUserListSchema,
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
  JiraCreateMetaIssueType,
  JiraEditMetaField,
  JiraIssueCreateBatchResult,
  JiraIssueCreateEntry,
  JiraIssueCreateInput,
  JiraIssueCreateOptions,
  JiraIssueCreateResult,
  JiraUser,
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
import { isJiraUserField, listMissingRequiredJiraFields, planJiraIssueFieldEdits, resolveJiraField } from "./jira-fields.js";
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


/**
 * Jira account ids are opaque, but Atlassian Cloud issues two shapes: a 24-character hex id, and a
 * `<prefix>:<uuid>` id. Matching those rather than any string with a colon keeps a display name that
 * happens to contain one from being sent as an account id.
 */
function looksLikeAccountId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value) || /^[a-z0-9]+:[0-9a-f-]{36}$/i.test(value);
}

function jiraFieldErrors(err: unknown): Record<string, string> | undefined {
  if (!(err instanceof AtlassianError) || err.statusCode !== 400) return undefined;
  const details = err.details;
  if (typeof details !== "object" || details === null) return undefined;
  const errors = (details as { errors?: unknown }).errors;
  if (typeof errors !== "object" || errors === null) return undefined;
  return errors as Record<string, string>;
}

/**
 * Re-codes Jira's 400 on create into the case the caller can act on. Jira answers a bad parent, a
 * missing required field, and a bad value with the same status, so the field error map is the only
 * thing that separates them.
 */
function translateCreateError(err: unknown): unknown {
  const errors = jiraFieldErrors(err);
  if (errors === undefined) return err;

  const parent = errors.parent;
  if (parent !== undefined) return new AtlassianFieldError(parent, "invalid_parent", { errors });

  // Jira words this as "Field 'x' is required" on some fields and "You must specify ..." on others.
  const required = Object.entries(errors).filter(([, text]) => /is required|must specify/i.test(String(text)));
  if (required.length > 0) {
    return new AtlassianFieldError(
      `Jira rejected the create: ${required.map(([, text]) => text).join("; ")}`,
      "missing_required_field",
      { requiredFields: required.map(([id]) => ({ id })), errors }
    );
  }

  return new AtlassianFieldError(
    `Jira rejected the create: ${Object.entries(errors).map(([id, text]) => `${id}: ${text}`).join("; ")}`,
    "invalid_field_value",
    { errors }
  );
}

/** How long cached create metadata stays good. */
const CREATE_META_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
  readonly value: T;
  readonly expires: number;
}

function cacheRead<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheWrite<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): T {
  cache.set(key, { value, expires: Date.now() + CREATE_META_TTL_MS });
  return value;
}

/** Jira takes a project by key or by id, and a numeric key is never valid. */
function projectRef(project: string): Record<string, string> {
  return /^\d+$/.test(project) ? { id: project } : { key: project };
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
  /**
   * A create needs two metadata lookups before it writes anything, so a batch into one project pays
   * for them once. The entries expire because an MCP server holds one client for hours and a create
   * screen can change under it; a CLI run never lives long enough to reach the timeout.
   */
  private readonly issueTypeCache = new Map<string, CacheEntry<JiraCreateMetaIssueType[]>>();
  private readonly createMetaCache = new Map<string, CacheEntry<JiraIssueEditMeta>>();

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
    const plan = planJiraIssueFieldEdits(meta, await this.resolveUserFieldValues(meta, edits));

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

  /** Project key or id for a project-scoped call, falling back to the configured default. */
  private resolveProject(project?: string): string {
    const resolved = project?.trim() !== undefined && project.trim().length > 0 ? project.trim() : this.config.jiraProject;
    if (resolved === undefined) throw new Error("project is required; pass a project key or set ATLASSIAN_JIRA_PROJECT");
    return resolved;
  }

  private browseUrl(key: string): string {
    return new URL(`/browse/${encodeURIComponent(key)}`, this.config.siteUrl).toString();
  }

  /** Issue types on a project's create screen, cached per client. */
  async listJiraIssueTypes(projectIdOrKey?: string): Promise<JiraCreateMetaIssueType[]> {
    const project = this.resolveProject(projectIdOrKey);
    const cached = cacheRead(this.issueTypeCache, project);
    if (cached !== undefined) return cached;

    const path = `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`;
    const values: JiraCreateMetaIssueType[] = [];
    const maxResults = 50;
    let startAt = 0;
    for (;;) {
      const data = await this.request<unknown>("GET", path, { query: { startAt, maxResults } });
      const page = JiraCreateMetaIssueTypePageSchema.parse(data);
      values.push(...page.values);
      // A short page is the last page; without this a server that ignores startAt would loop. The
      // page's own maxResults wins, since Jira may cap the page below what was asked for.
      if (page.values.length < (page.maxResults ?? maxResults)) break;
      if (page.total !== undefined && values.length >= page.total) break;
      startAt += page.values.length;
    }

    return cacheWrite(this.issueTypeCache, project, values);
  }

  /** Resolves an issue type by id or display name, reporting the project's real types on a miss. */
  async resolveJiraIssueType(projectIdOrKey: string | undefined, issueType: string): Promise<JiraCreateMetaIssueType> {
    const project = this.resolveProject(projectIdOrKey);
    const types = await this.listJiraIssueTypes(project);
    const wanted = issueType.trim().toLowerCase();
    const match = types.find((type) => type.id === issueType.trim()) ?? types.find((type) => type.name.trim().toLowerCase() === wanted);
    if (match !== undefined) return match;

    throw new AtlassianFieldError(`"${issueType}" is not an issue type in ${project}`, "invalid_issue_type", {
      project,
      issueTypes: types.map((type) => ({ id: type.id, name: type.name, subtask: type.subtask })),
    });
  }

  /**
   * The create screen for one issue type, in the same shape `editmeta` reports, so field resolution
   * and value coercion are the same code on create as on edit.
   */
  async getJiraCreateMeta(projectIdOrKey: string | undefined, issueTypeId: string): Promise<JiraIssueEditMeta> {
    const project = this.resolveProject(projectIdOrKey);
    const cacheKey = `${project}:${issueTypeId}`;
    const cached = cacheRead(this.createMetaCache, cacheKey);
    if (cached !== undefined) return cached;

    const path = `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(issueTypeId)}`;
    const fields: Record<string, JiraEditMetaField> = {};
    const maxResults = 50;
    let startAt = 0;
    let seen = 0;
    for (;;) {
      const data = await this.request<unknown>("GET", path, { query: { startAt, maxResults } });
      const page = JiraCreateMetaFieldPageSchema.parse(data);
      for (const field of page.values) {
        const id = field.fieldId ?? field.key;
        if (id !== undefined) fields[id] = field;
      }
      seen += page.values.length;
      if (page.values.length < (page.maxResults ?? maxResults)) break;
      if (page.total !== undefined && seen >= page.total) break;
      startAt += page.values.length;
    }

    return cacheWrite(this.createMetaCache, cacheKey, JiraIssueEditMetaSchema.parse({ fields }));
  }

  async searchJiraUsers(query: string): Promise<JiraUser[]> {
    const data = await this.request<unknown>("GET", "/rest/api/3/user/search", {
      query: { query: requireNonEmpty(query, "query"), maxResults: 50 },
    });
    return JiraUserListSchema.parse(data);
  }

  /**
   * Turns an email address or display name into the account id Jira wants, so a caller does not
   * have to look one up first. An account id is passed straight through.
   */
  async resolveJiraAccountId(input: string): Promise<string> {
    const query = input.trim();
    if (looksLikeAccountId(query)) return query;

    const users = (await this.searchJiraUsers(query)).filter((user) => user.active !== false);
    const wanted = query.toLowerCase();
    const byEmail = users.filter((user) => user.emailAddress?.trim().toLowerCase() === wanted);
    const byName = users.filter((user) => user.displayName?.trim().toLowerCase() === wanted);
    const candidates = byEmail.length > 0 ? byEmail : byName.length > 0 ? byName : users;

    const first = candidates[0];
    if (first === undefined) throw new AtlassianFieldError(`No Jira user matches "${input}"`, "user_not_found", { query: input });
    if (candidates.length > 1) {
      throw new AtlassianFieldError(`"${input}" matches ${candidates.length} Jira users; pass the account id`, "user_ambiguous", {
        query: input,
        candidates: candidates.map((user) => ({ accountId: user.accountId, displayName: user.displayName, emailAddress: user.emailAddress })),
      });
    }
    return first.accountId;
  }

  /**
   * Rewrites user-field values that are emails or display names into account ids before planning.
   * Fields that cannot be resolved are left alone so planning reports the real error for them.
   */
  private async resolveUserFieldValues(meta: JiraIssueEditMeta, edits: JiraFieldEdits): Promise<JiraFieldEdits> {
    const resolved: Record<string, unknown> = { ...edits };

    for (const [input, raw] of Object.entries(edits)) {
      if (typeof raw !== "string" || raw.trim().length === 0 || raw.startsWith("json:")) continue;

      let field: JiraEditMetaField;
      try {
        field = resolveJiraField(meta, input).field;
      } catch {
        continue;
      }
      if (!isJiraUserField(field)) continue;

      if (field.schema?.type === "array") {
        const names = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
        const accountIds: string[] = [];
        for (const name of names) accountIds.push(await this.resolveJiraAccountId(name));
        resolved[input] = accountIds;
        continue;
      }
      resolved[input] = await this.resolveJiraAccountId(raw);
    }

    return resolved;
  }

  /**
   * Creates one issue. The issue type and every field are resolved against the project's create
   * screen first, so a value that cannot work is rejected with the allowed options before the write
   * rather than as a bare Jira 400 afterwards. `dryRun` returns the full resolved payload unsent.
   */
  async createJiraIssue(input: JiraIssueCreateInput, opts: JiraIssueCreateOptions = {}): Promise<JiraIssueCreateResult> {
    const project = this.resolveProject(input.project);
    const issueType = await this.resolveJiraIssueType(project, input.issueType);
    const meta = await this.getJiraCreateMeta(project, issueType.id);

    const requested: Record<string, unknown> = { ...input.fields };
    // The shorthands are the same fields under fixed names, so a collision is reported rather than
    // silently resolved in favour of one of them.
    for (const [name, value] of [["summary", input.summary], ["description", input.description], ["parent", input.parent]] as const) {
      if (value === undefined) continue;
      if (name in requested) throw new AtlassianFieldError(`${name} was given twice`, "field_duplicated", { field: name });
      requested[name] = value;
    }

    const plan = Object.keys(requested).length === 0
      ? { fields: {}, resolved: [] }
      : planJiraIssueFieldEdits(meta, await this.resolveUserFieldValues(meta, requested), `${issueType.name} in ${project}`);

    // project and issuetype are set from the resolved project and issue type, so a caller field
    // that would be overwritten by them is an error instead of a value that is quietly dropped.
    for (const reserved of ["project", "issuetype"]) {
      if (reserved in plan.fields) {
        throw new AtlassianFieldError(
          `${reserved} is set from the issue's project and type, not as a field`,
          "field_not_settable",
          { field: reserved, project, issueType: { id: issueType.id, name: issueType.name } }
        );
      }
    }

    const missing = listMissingRequiredJiraFields(meta, Object.keys(plan.fields));
    if (missing.length > 0) {
      throw new AtlassianFieldError(
        `${issueType.name} in ${project} requires ${missing.map((field) => field.name ?? field.id).join(", ")}`,
        "missing_required_field",
        { project, issueType: { id: issueType.id, name: issueType.name }, requiredFields: missing }
      );
    }

    // One payload for both paths, so a dry run prints exactly the body the create would send.
    const base = {
      project,
      issueType: { id: issueType.id, name: issueType.name, subtask: issueType.subtask },
      resolved: plan.resolved,
      fields: { ...plan.fields, project: projectRef(project), issuetype: { id: issueType.id } },
    };
    if (opts.dryRun === true) return { ...base, status: "dry_run" };

    const created = await this.postJiraIssue(base.fields);
    return { ...base, status: "created", key: created.key, id: created.id, url: this.browseUrl(created.key) };
  }

  private async postJiraIssue(fields: Record<string, unknown>) {
    try {
      const data = await this.request<unknown>("POST", "/rest/api/3/issue", { body: { fields } });
      return JiraCreatedIssueSchema.parse(data);
    } catch (err) {
      throw translateCreateError(err);
    }
  }

  /**
   * Creates several issues, reporting per record and continuing past failures, so one bad record in
   * a reviewed batch does not strand the rest. Metadata lookups are shared across the batch.
   */
  async createJiraIssues(inputs: readonly JiraIssueCreateInput[], opts: JiraIssueCreateOptions = {}): Promise<JiraIssueCreateBatchResult> {
    if (inputs.length === 0) throw new AtlassianFieldError("Provide at least one issue to create", "field_required");

    const results: JiraIssueCreateEntry[] = [];
    for (const [index, input] of inputs.entries()) {
      try {
        results.push({ index, ...(await this.createJiraIssue(input, opts)) });
      } catch (err) {
        results.push({
          status: "error",
          index,
          project: input.project ?? this.config.jiraProject,
          issueType: input.issueType,
          summary: input.summary ?? (typeof input.fields?.summary === "string" ? input.fields.summary : undefined),
          code: editFailureCode(err),
          message: err instanceof Error ? err.message : String(err),
          details: err instanceof AtlassianError ? err.details : undefined,
        });
      }
    }

    return {
      created: results.filter((result) => result.status !== "error").length,
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
