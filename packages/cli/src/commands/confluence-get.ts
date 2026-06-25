import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";

interface GetFlags {
  readonly json: boolean;
}

export const confluenceGetCommand = buildCommand({
  docs: {
    brief: "Get a Confluence page by ID",
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
      parameters: [{ brief: "Page ID", parse: String }],
    },
  },
  async func(this: void, flags: GetFlags, pageId: string) {
    try {
      const client = new AtlassianClient(resolveConfig());
      const page = await client.getConfluencePage(pageId);

      if (flags.json) {
        console.log(JSON.stringify(page, null, 2));
        return;
      }

      console.log(`id: ${page.id}`);
      if (page.title) console.log(`title: ${page.title}`);
      if (page.status) console.log(`status: ${page.status}`);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
