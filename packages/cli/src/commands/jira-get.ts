import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";

interface GetFlags {
  readonly json: boolean;
}

export const jiraGetCommand = buildCommand({
  docs: {
    brief: "Get a Jira issue by key or ID",
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Output as JSON",
        default: false,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Issue key or ID", parse: String }],
    },
  },
  async func(this: void, flags: GetFlags, issueIdOrKey: string) {
    try {
      const client = new AtlassianClient(resolveConfig());
      const issue = await client.getJiraIssue(issueIdOrKey);

      if (flags.json) {
        console.log(JSON.stringify(issue, null, 2));
        return;
      }

      console.log(`key: ${issue.key}`);
      console.log(`id: ${issue.id}`);
      if (typeof issue.fields?.summary === "string") console.log(`summary: ${issue.fields.summary}`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
