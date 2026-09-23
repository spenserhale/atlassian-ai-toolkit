import { z } from "zod";

export const AtlassianConfigSchema = z.object({
  siteUrl: z.string().url("ATLASSIAN_SITE_URL must be a URL"),
  email: z.string().email("ATLASSIAN_EMAIL must be an email address"),
  apiToken: z.string().min(1, "ATLASSIAN_API_TOKEN is required"),
  // Story point field ids differ per site, so the id is configuration rather than a constant.
  storyPointsField: z.string().min(1).optional(),
  // Default board for board-scoped sprint commands, so callers can omit the board id.
  jiraBoardId: z.number().int().positive().optional(),
  // Default project for project-scoped commands, so callers can omit the project key.
  jiraProject: z.string().min(1).optional(),
});

export type AtlassianConfig = z.infer<typeof AtlassianConfigSchema>;

export const AtlassianErrorResponseSchema = z
  .object({
    errorMessages: z.array(z.string()).optional(),
    errors: z.record(z.string()).optional(),
    message: z.string().optional(),
    statusCode: z.number().optional(),
    code: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

export type AtlassianErrorResponse = z.infer<typeof AtlassianErrorResponseSchema>;

export const JiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string().optional(),
  fields: z.record(z.unknown()).optional(),
}).passthrough();

export type JiraIssue = z.infer<typeof JiraIssueSchema>;

export const JiraSearchPageSchema = z.object({
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
  issues: z.array(JiraIssueSchema),
}).passthrough();

export type JiraSearchPage = z.infer<typeof JiraSearchPageSchema>;

export const JiraApproximateCountSchema = z.object({
  count: z.number(),
}).passthrough();

export type JiraApproximateCount = z.infer<typeof JiraApproximateCountSchema>;

export interface JiraSearchResult {
  readonly issues: JiraIssue[];
  /** Exact when `isLast`; otherwise Jira's approximate count for the query. */
  readonly total: number;
  /** False when the walk stopped at `limit` rather than exhausting the result set. */
  readonly isLast: boolean;
  /** Always 0. The enhanced search endpoint pages by token; reported for parity with sprint lists. */
  readonly startAt: number;
  readonly maxResults: number;
}

export interface JiraSearchOptions {
  readonly maxResults?: number;
  readonly fields?: readonly string[];
  readonly limit?: number;
}

export const JiraAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  created: z.string().optional(),
  content: z.string().optional(),
  self: z.string().optional(),
}).passthrough();

export type JiraAttachment = z.infer<typeof JiraAttachmentSchema>;

export const JiraAttachmentListSchema = z.array(JiraAttachmentSchema);

export const JiraSprintStateSchema = z.enum(["future", "active", "closed"]);

export type JiraSprintState = z.infer<typeof JiraSprintStateSchema>;

export const JiraSprintSchema = z.object({
  id: z.number(),
  self: z.string().optional(),
  state: JiraSprintStateSchema,
  name: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  completeDate: z.string().optional(),
  originBoardId: z.number().optional(),
  goal: z.string().optional(),
}).passthrough();

export type JiraSprint = z.infer<typeof JiraSprintSchema>;

export const JiraSprintListSchema = z.object({
  maxResults: z.number().optional(),
  startAt: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
  values: z.array(JiraSprintSchema),
}).passthrough();

export type JiraSprintList = z.infer<typeof JiraSprintListSchema>;

export interface JiraSprintListOptions {
  readonly state?: JiraSprintState;
  readonly maxResults?: number;
}

export const JiraSprintIssuePageSchema = z.object({
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
  issues: z.array(JiraIssueSchema),
}).passthrough();

export type JiraSprintIssuePage = z.infer<typeof JiraSprintIssuePageSchema>;

export interface JiraSprintIssueList {
  readonly total: number;
  readonly issues: JiraIssue[];
}

export const DEFAULT_JIRA_STORY_POINTS_FIELD = "customfield_10105";

export interface JiraSprintPointsOptions {
  /** Story point field id; defaults to the configured field, then DEFAULT_JIRA_STORY_POINTS_FIELD. */
  readonly pointsField?: string;
}

export interface JiraSprintPoints {
  readonly field: string;
  readonly committed: number;
  readonly completed: number;
  readonly issueCount: number;
  /** Issues carrying no numeric estimate, so a low `committed` is visible rather than silent. */
  readonly unestimated: number;
}

export interface JiraSprintIssueListOptions {
  readonly maxResults?: number;
  readonly fields?: readonly string[];
}

export interface CreateJiraSprintInput {
  /** Resolved against the configured default board (`ATLASSIAN_JIRA_BOARD_ID`) when omitted. */
  readonly originBoardId?: number;
  readonly name: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly goal?: string;
}

export interface UpdateJiraSprintInput {
  readonly name?: string;
  readonly state?: JiraSprintState;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly goal?: string;
}

export type MoveJiraSprintIssuesInput =
  | { readonly issueKeys: readonly string[]; readonly targetSprintId: number }
  | { readonly issueKeys: readonly string[]; readonly target: "backlog" };

export interface JiraSprintIssueMoveBatchFailure {
  readonly batchIndex: number;
  readonly issueKeys: readonly string[];
  readonly error: string;
}

export interface JiraSprintIssueMoveResult {
  readonly batches: number;
  readonly moved: number;
  readonly failed: readonly JiraSprintIssueMoveBatchFailure[];
}

export const ConfluencePageSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  title: z.string().optional(),
  spaceId: z.string().optional(),
  parentId: z.string().optional(),
}).passthrough();

export type ConfluencePage = z.infer<typeof ConfluencePageSchema>;

export const ConfluenceAttachmentSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  extensions: z.record(z.unknown()).optional(),
  version: z.record(z.unknown()).optional(),
  _links: z.record(z.unknown()).optional(),
}).passthrough();

export type ConfluenceAttachment = z.infer<typeof ConfluenceAttachmentSchema>;

export const ConfluenceAttachmentUploadResultSchema = z.object({
  results: z.array(ConfluenceAttachmentSchema),
  start: z.number().optional(),
  limit: z.number().optional(),
  size: z.number().optional(),
  _links: z.record(z.unknown()).optional(),
}).passthrough();

export type ConfluenceAttachmentUploadResult = z.infer<typeof ConfluenceAttachmentUploadResultSchema>;

export interface ConfluenceAttachmentUploadInput {
  readonly file: Blob;
  readonly filename: string;
  readonly comment?: string;
  readonly minorEdit?: boolean;
  readonly createOnly?: boolean;
}

export const JiraFieldSchemaSchema = z.object({
  type: z.string().optional(),
  items: z.string().optional(),
  custom: z.string().optional(),
  customId: z.number().optional(),
  system: z.string().optional(),
}).passthrough();

export type JiraFieldSchema = z.infer<typeof JiraFieldSchemaSchema>;

export const JiraEditMetaFieldSchema = z.object({
  required: z.boolean().optional(),
  name: z.string().optional(),
  key: z.string().optional(),
  fieldId: z.string().optional(),
  operations: z.array(z.string()).optional(),
  schema: JiraFieldSchemaSchema.optional(),
  allowedValues: z.array(z.unknown()).optional(),
  // Create metadata reports whether Jira fills the field itself when it is left out.
  hasDefaultValue: z.boolean().optional(),
}).passthrough();

export type JiraEditMetaField = z.infer<typeof JiraEditMetaFieldSchema>;

export const JiraIssueEditMetaSchema = z.object({
  fields: z.record(JiraEditMetaFieldSchema).default({}),
}).passthrough();

export type JiraIssueEditMeta = z.infer<typeof JiraIssueEditMetaSchema>;

/** A field the issue's edit screen accepts, as reported back when a requested field is rejected. */
export interface JiraSettableField {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
}

/** A required create-screen field the payload does not set, with its options when it publishes any. */
export interface JiraRequiredFieldGap extends JiraSettableField {
  readonly allowedValues?: readonly string[];
}

/** One requested edit after its field was resolved and its value coerced to the API shape. */
export interface JiraResolvedFieldEdit {
  /** The field id or display name the caller asked for. */
  readonly input: string;
  readonly fieldId: string;
  readonly name?: string;
  readonly type?: string;
  readonly value: unknown;
}

export interface JiraIssueEditPlan {
  /** The `fields` object that would be sent to Jira. */
  readonly fields: Record<string, unknown>;
  readonly resolved: readonly JiraResolvedFieldEdit[];
}

/** Raw field edits keyed by field id or display name; values are coerced against the edit metadata. */
export type JiraFieldEdits = Readonly<Record<string, unknown>>;

export interface JiraIssueFieldEdits {
  readonly key: string;
  readonly fields: JiraFieldEdits;
}

export interface JiraIssueEditOptions {
  /** Resolve and validate the payload without sending it. */
  readonly dryRun?: boolean;
  /** Jira notifies watchers by default; pass false to edit quietly. */
  readonly notifyUsers?: boolean;
}

export interface JiraIssueEditResult extends JiraIssueEditPlan {
  readonly key: string;
  readonly status: "updated" | "dry_run";
}

export interface JiraIssueEditFailure {
  readonly key: string;
  readonly status: "error";
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type JiraIssueEditEntry = JiraIssueEditResult | JiraIssueEditFailure;

export interface JiraIssueEditBatchResult {
  readonly updated: number;
  readonly failed: number;
  readonly results: readonly JiraIssueEditEntry[];
}

export const JiraCreateMetaIssueTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  subtask: z.boolean().optional(),
}).passthrough();

export type JiraCreateMetaIssueType = z.infer<typeof JiraCreateMetaIssueTypeSchema>;

/**
 * Atlassian's own spec keys this page `issueTypes` (and `createMetaIssueType` on the write side),
 * while some responses key it `values`. Reading one key only yields a silently empty issue type
 * list, so every accepted key is normalised onto `values`.
 */
export const JiraCreateMetaIssueTypePageSchema = z
  .object({
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
    values: z.array(JiraCreateMetaIssueTypeSchema).optional(),
    issueTypes: z.array(JiraCreateMetaIssueTypeSchema).optional(),
    createMetaIssueType: z.array(JiraCreateMetaIssueTypeSchema).optional(),
  })
  .passthrough()
  .transform((page) => ({ ...page, values: page.values ?? page.issueTypes ?? page.createMetaIssueType ?? [] }));

export type JiraCreateMetaIssueTypePage = z.infer<typeof JiraCreateMetaIssueTypePageSchema>;

/** A create screen field. Same shape as an edit meta field, keyed by `fieldId` instead of a map key. */
export const JiraCreateMetaFieldSchema = JiraEditMetaFieldSchema;

/** Keyed `fields` in Atlassian's spec, `results` in its write schema, `values` in some responses. */
export const JiraCreateMetaFieldPageSchema = z
  .object({
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
    values: z.array(JiraCreateMetaFieldSchema).optional(),
    fields: z.array(JiraCreateMetaFieldSchema).optional(),
    results: z.array(JiraCreateMetaFieldSchema).optional(),
  })
  .passthrough()
  .transform((page) => ({ ...page, values: page.values ?? page.fields ?? page.results ?? [] }));

export type JiraCreateMetaFieldPage = z.infer<typeof JiraCreateMetaFieldPageSchema>;

export const JiraCreatedIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string().optional(),
}).passthrough();

export type JiraCreatedIssue = z.infer<typeof JiraCreatedIssueSchema>;

export const JiraUserSchema = z.object({
  accountId: z.string(),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
  accountType: z.string().optional(),
}).passthrough();

export type JiraUser = z.infer<typeof JiraUserSchema>;

export const JiraUserListSchema = z.array(JiraUserSchema);

/** One issue to create. `summary`, `description`, and `parent` are shorthands for the same fields. */
export interface JiraIssueCreateInput {
  /** Project key or id; resolved against ATLASSIAN_JIRA_PROJECT when omitted. */
  readonly project?: string;
  /** Issue type display name or id, resolved against the project's create metadata. */
  readonly issueType: string;
  readonly summary?: string;
  /** Markdown; converted to ADF because Jira's v3 API rejects a plain string here. */
  readonly description?: string;
  /** Parent issue key, for a sub-task or for placing an issue under an epic. */
  readonly parent?: string;
  /** Any other field, keyed by field id or display name, coerced against the create screen. */
  readonly fields?: JiraFieldEdits;
}

export interface JiraIssueCreateOptions {
  /** Resolve and validate the create payload without sending it. */
  readonly dryRun?: boolean;
}

export interface JiraIssueCreateIssueType {
  readonly id: string;
  readonly name: string;
  readonly subtask?: boolean;
}

export interface JiraIssueCreatePlan extends JiraIssueEditPlan {
  readonly project: string;
  readonly issueType: JiraIssueCreateIssueType;
}

export interface JiraIssueCreateResult extends JiraIssueCreatePlan {
  readonly status: "created" | "dry_run";
  readonly key?: string;
  readonly id?: string;
  /** Browse URL of the created issue, so the key can be handed straight to a human. */
  readonly url?: string;
}

export interface JiraIssueCreateFailure {
  readonly status: "error";
  /** Position in the requested batch, so a failure maps back to its input record. */
  readonly index: number;
  readonly project?: string;
  readonly issueType?: string;
  readonly summary?: string;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type JiraIssueCreateEntry = (JiraIssueCreateResult & { readonly index: number }) | JiraIssueCreateFailure;

export interface JiraIssueCreateBatchResult {
  readonly created: number;
  readonly failed: number;
  readonly results: readonly JiraIssueCreateEntry[];
}
