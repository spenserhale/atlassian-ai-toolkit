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
}
