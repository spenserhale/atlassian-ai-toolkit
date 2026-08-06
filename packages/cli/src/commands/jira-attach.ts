import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";
import type { JiraAttachmentUpload } from "@atlassian-ai-toolkit/sdk";

interface AttachFlags {
  readonly file: readonly string[];
  readonly json: boolean;
}

export const jiraAttachCommand = buildCommand({
  docs: {
    brief: "Upload one or more file attachments to a Jira issue",
  },
  parameters: {
    flags: {
      file: {
        kind: "parsed",
        parse: String,
        brief: "Path to a file to upload; repeat for multiple files",
        variadic: true,
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
  async func(this: void, flags: AttachFlags, issueIdOrKey: string) {
    try {
      const uploads: JiraAttachmentUpload[] = await Promise.all(
        flags.file.map(async (path): Promise<JiraAttachmentUpload> => ({
          filename: basename(path),
          data: await readFile(path),
        }))
      );

      const client = new AtlassianClient(resolveConfig());
      const attachments = await client.addJiraAttachments(issueIdOrKey, uploads);

      if (flags.json) {
        console.log(JSON.stringify({ status: "uploaded", issue: issueIdOrKey, attachments }, null, 2));
        return;
      }

      console.log(`status: uploaded`);
      console.log(`issue: ${issueIdOrKey}`);
      for (const attachment of attachments) {
        console.log(`attachment: ${attachment.id} ${attachment.filename ?? ""} (${attachment.size ?? "?"} bytes)`);
      }
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
