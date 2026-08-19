import { z } from "zod";

export const AtlassianConfigSchema = z.object({
  siteUrl: z.string().url("ATLASSIAN_SITE_URL must be a URL"),
  email: z.string().email("ATLASSIAN_EMAIL must be an email address"),
  apiToken: z.string().min(1, "ATLASSIAN_API_TOKEN is required"),
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

export interface JiraSearchResult {
  readonly issues: JiraIssue[];
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

export interface JiraSprintIssueListOptions {
  readonly maxResults?: number;
  readonly fields?: readonly string[];
}

export interface CreateJiraSprintInput {
  readonly originBoardId: number;
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
