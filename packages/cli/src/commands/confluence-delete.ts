import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";

interface DeleteFlags {
  readonly confirm?: string;
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
      confirm: {
        kind: "parsed",
        parse: String,
        brief: "Page ID required with --force",
        optional: true,
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
      const page = await client.getConfluencePage(pageId);

      if (flags["dry-run"] || !flags.force) {
        const result = {
          status: "dry_run",
          wouldDelete: { id: page.id, title: page.title, status: page.status },
          purge: flags.purge,
          hint: flags.purge
            ? `Pass --force --purge --confirm ${page.id} to permanently purge this already-trashed page.`
            : `Pass --force --confirm ${page.id} to move this Confluence page to trash.`,
        };
        console.log(flags.json ? JSON.stringify(result, null, 2) : `status: dry_run\nwould_delete: ${page.id}\nhint: ${result.hint}`);
        return;
      }

      if (flags.confirm !== page.id) {
        const result = {
          status: "confirmation_required",
          page: { id: page.id, title: page.title, status: page.status },
          hint: flags.purge
            ? `Re-run with --force --purge --confirm ${page.id} to permanently purge this page.`
            : `Re-run with --force --confirm ${page.id} to move this page to trash.`,
        };
        console.log(flags.json ? JSON.stringify(result, null, 2) : `status: confirmation_required\npage: ${page.id}\nhint: ${result.hint}`);
        process.exit(2);
      }

      await client.deleteConfluencePage(pageId, { purge: flags.purge });
      const result = { status: flags.purge ? "purged" : "trashed", page: { id: page.id, title: page.title } };
      console.log(flags.json ? JSON.stringify(result, null, 2) : `status: ${result.status}\npage: ${page.id}`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
