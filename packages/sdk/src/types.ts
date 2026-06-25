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

export const ConfluencePageSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  title: z.string().optional(),
  spaceId: z.string().optional(),
  parentId: z.string().optional(),
}).passthrough();

export type ConfluencePage = z.infer<typeof ConfluencePageSchema>;
