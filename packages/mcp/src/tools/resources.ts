import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";

function getClient(): AtlassianClient {
  const config = resolveConfig();
  return new AtlassianClient(config);
}

export function registerResourceTools(server: FastMCP) {
  server.addTool({
    name: "jira_get_issue",
    description: "Get one Jira issue by key or id.",
    parameters: z.object({
      issueIdOrKey: z.string().describe("Jira issue key or id"),
    }),
    execute: async (args) => {
      const issue = await getClient().getJiraIssue(args.issueIdOrKey);
      return JSON.stringify(issue, null, 2);
    },
  });

  server.addTool({
    name: "jira_delete_issue",
    description: "Preview or delete one Jira issue. Deletion requires force true and confirm matching the issue key or id.",
    parameters: z.object({
      issueIdOrKey: z.string().describe("Jira issue key or id"),
      deleteSubtasks: z.boolean().default(false).describe("Also delete subtasks"),
      force: z.boolean().default(false).describe("Must be true to delete"),
      confirm: z.string().optional().describe("Must match fetched issue key or id when force is true"),
    }),
    execute: async (args) => {
      const client = getClient();
      const issue = await client.getJiraIssue(args.issueIdOrKey);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          wouldDelete: { id: issue.id, key: issue.key, summary: issue.fields?.summary },
          deleteSubtasks: args.deleteSubtasks,
          hint: `Call again with force true and confirm "${issue.key}" to permanently delete this Jira issue.`,
        }, null, 2);
      }

      if (args.confirm !== issue.key && args.confirm !== issue.id) {
        return JSON.stringify({
          status: "confirmation_required",
          issue: { id: issue.id, key: issue.key, summary: issue.fields?.summary },
          hint: `Call again with force true and confirm "${issue.key}" to permanently delete this Jira issue.`,
        }, null, 2);
      }

      await client.deleteJiraIssue(args.issueIdOrKey, { deleteSubtasks: args.deleteSubtasks });
      return JSON.stringify({ status: "deleted", issue: { id: issue.id, key: issue.key }, deleteSubtasks: args.deleteSubtasks }, null, 2);
    },
  });

  server.addTool({
    name: "confluence_get_page",
    description: "Get one Confluence page by id.",
    parameters: z.object({
      pageId: z.string().describe("Confluence page id"),
    }),
    execute: async (args) => {
      const page = await getClient().getConfluencePage(args.pageId);
      return JSON.stringify(page, null, 2);
    },
  });

  server.addTool({
    name: "confluence_delete_page",
    description: "Preview, trash, or purge one Confluence page. Deletion requires force true and confirm matching the page id.",
    parameters: z.object({
      pageId: z.string().describe("Confluence page id"),
      purge: z.boolean().default(false).describe("Permanently purge an already-trashed page"),
      force: z.boolean().default(false).describe("Must be true to delete"),
      confirm: z.string().optional().describe("Must match fetched page id when force is true"),
    }),
    execute: async (args) => {
      const client = getClient();
      const page = await client.getConfluencePage(args.pageId);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          wouldDelete: { id: page.id, title: page.title, status: page.status },
          purge: args.purge,
          hint: `Call again with force true and confirm "${page.id}" to ${args.purge ? "purge" : "trash"} this Confluence page.`,
        }, null, 2);
      }

      if (args.confirm !== page.id) {
        return JSON.stringify({
          status: "confirmation_required",
          page: { id: page.id, title: page.title, status: page.status },
          hint: `Call again with force true and confirm "${page.id}" to ${args.purge ? "purge" : "trash"} this Confluence page.`,
        }, null, 2);
      }

      await client.deleteConfluencePage(args.pageId, { purge: args.purge });
      return JSON.stringify({ status: args.purge ? "purged" : "trashed", page: { id: page.id, title: page.title } }, null, 2);
    },
  });
}
