import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";
import type { JiraIssue } from "@atlassian-ai-toolkit/sdk";

interface SearchFlags {
  readonly jql: string;
  readonly limit?: string;
  readonly json: boolean;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--limit must be a positive integer (got: "${value}")`);
  return parsed;
}

function formatIssue(issue: JiraIssue): string {
  const summary = typeof issue.fields?.summary === "string" ? issue.fields.summary : "";
  const status = issue.fields?.status;
  const statusName = typeof status === "object" && status !== null && typeof (status as { name?: unknown }).name === "string"
    ? ` (${(status as { name: string }).name})`
    : "";
  return `- ${issue.key}: ${summary}${statusName}`;
}

export const jiraSearchCommand = buildCommand({
  docs: {
    brief: "Search Jira issues with JQL",
  },
  parameters: {
    flags: {
      jql: { kind: "parsed", parse: String, brief: "JQL query, for example: project = PROJ AND sprint = 42" },
      limit: { kind: "parsed", parse: String, brief: "Stop after this many issues", optional: true },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
  },
  async func(this: void, flags: SearchFlags) {
    try {
      if (flags.jql.trim().length === 0) throw new Error("--jql must be a non-empty JQL query");
      const result = await new AtlassianClient(resolveConfig()).searchJiraIssues(flags.jql, {
        limit: parseLimit(flags.limit),
      });
      const text = [`issues[${result.issues.length}]:`, ...result.issues.map(formatIssue)].join("\n");
      console.log(flags.json ? JSON.stringify(result, null, 2) : text);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
