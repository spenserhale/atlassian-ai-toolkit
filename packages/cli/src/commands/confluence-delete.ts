import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";

interface DeleteFlags {
  readonly "dry-run": boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly purge: boolean;
}

export const confluenceDeleteCommand = buildCommand({
  docs: {
    brief: "Trash or purge a Confluence page; requires --force unless --dry-run is set",
  },
  parameters: {
    flags: {
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
      purge: {
        kind: "boolean",
        brief: "Permanently purge an already-trashed page",
        default: false,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Page ID", parse: String }],
    },
  },
  async func(this: void, flags: DeleteFlags, pageId: string) {
    try {
      const client = new AtlassianClient(resolveConfig());

      if (flags["dry-run"] || !flags.force) {
        const page = await client.getConfluencePage(pageId);
        const result = {
          status: "dry_run",
          wouldDelete: { id: page.id, title: page.title, status: page.status },
          purge: flags.purge,
          hint: flags.purge
            ? "Pass --force --purge to permanently purge this already-trashed page."
            : "Pass --force to move this Confluence page to trash.",
        };
        console.log(flags.json ? JSON.stringify(result, null, 2) : `status: dry_run\nwould_delete: ${page.id}\nhint: ${result.hint}`);
        return;
      }

      await client.deleteConfluencePage(pageId, { purge: flags.purge });
      const result = { status: flags.purge ? "purged" : "trashed", pageId };
      console.log(flags.json ? JSON.stringify(result, null, 2) : `status: ${result.status}\npage: ${pageId}`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
