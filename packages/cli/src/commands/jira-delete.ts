import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";

interface DeleteFlags {
  readonly "delete-subtasks": boolean;
  readonly "dry-run": boolean;
  readonly force: boolean;
  readonly json: boolean;
}

export const jiraDeleteCommand = buildCommand({
  docs: {
    brief: "Delete a Jira issue; requires --force unless --dry-run is set",
  },
  parameters: {
    flags: {
      "delete-subtasks": {
        kind: "boolean",
        brief: "Also delete subtasks",
        default: false,
      },
      "dry-run": {
        kind: "boolean",
        brief: "Show what would be deleted without deleting it",
        default: false,
      },
      force: {
        kind: "boolean",
        brief: "Required to perform the delete",
        default: false,
      },
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
  async func(this: void, flags: DeleteFlags, issueIdOrKey: string) {
    try {
      const client = new AtlassianClient(resolveConfig());

      if (flags["dry-run"] || !flags.force) {
        const issue = await client.getJiraIssue(issueIdOrKey);
        const result = {
          status: "dry_run",
          wouldDelete: { id: issue.id, key: issue.key, summary: issue.fields?.summary },
          deleteSubtasks: flags["delete-subtasks"],
          hint: "Pass --force to permanently delete this Jira issue.",
        };
        console.log(flags.json ? JSON.stringify(result, null, 2) : `status: dry_run\nwould_delete: ${issue.key}\nhint: ${result.hint}`);
        return;
      }

      await client.deleteJiraIssue(issueIdOrKey, { deleteSubtasks: flags["delete-subtasks"] });
      const result = { status: "deleted", issueIdOrKey, deleteSubtasks: flags["delete-subtasks"] };
      console.log(flags.json ? JSON.stringify(result, null, 2) : `status: deleted\nissue: ${issueIdOrKey}`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
