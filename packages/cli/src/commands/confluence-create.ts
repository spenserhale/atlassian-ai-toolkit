import { buildCommand } from "@stricli/core";
import { AtlassianClient, loadConfig } from "@atlassian-ai-toolkit/sdk";
import { SUPPORTED_MARKDOWN, parseBodyFormat, readBody } from "../body.js";
import { formatCreate } from "../confluence-format.js";
import { UsageError, handleError } from "../errors.js";

interface CreateFlags {
  readonly title: string;
  readonly parent?: string;
  readonly space?: string;
  readonly body?: string;
  readonly "body-file"?: string;
  readonly format?: string;
  readonly draft: boolean;
  readonly label: readonly string[];
  readonly "dry-run": boolean;
  readonly json: boolean;
}

export const confluenceCreateCommand = buildCommand({
  docs: {
    brief: "Create a Confluence page under a parent or in a space; --dry-run checks placement",
    fullDescription: [
      "With --parent the page takes the parent's space. A title already in the space fails with",
      "title_exists. --dry-run prints the space, the parent's ancestor path, and the body size.",
      "Confluence notifies watchers per its own defaults; the v2 API has no minor-edit switch.",
      SUPPORTED_MARKDOWN,
      "",
      "Examples:",
      '  atlassian confluence create --title "Q3 runbook" --parent 123456 --body-file runbook.md --dry-run',
      '  atlassian confluence create --title "Notes" --space ENG --body "# Notes" --draft --label notes',
    ].join("\n"),
  },
  parameters: {
    flags: {
      title: { kind: "parsed", parse: String, brief: "Page title" },
      parent: { kind: "parsed", parse: String, brief: "Parent page ID; the space comes from it", optional: true },
      space: { kind: "parsed", parse: String, brief: "Space key or ID, when there is no parent", optional: true },
      body: { kind: "parsed", parse: String, brief: "Page body", optional: true },
      "body-file": { kind: "parsed", parse: String, brief: "File holding the page body (- for stdin)", optional: true },
      format: { kind: "parsed", parse: String, brief: "Body format: markdown (default), storage, or adf", optional: true },
      draft: { kind: "boolean", brief: "Create an unpublished draft", default: false },
      label: { kind: "parsed", parse: String, brief: "Label to add; repeatable", variadic: true, default: [] },
      "dry-run": { kind: "boolean", brief: "Resolve placement and body without creating", default: false },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
  },
  async func(this: void, flags: CreateFlags) {
    try {
      if ((flags.parent === undefined) === (flags.space === undefined)) throw new UsageError("Pass exactly one of --parent or --space");
      const body = await readBody(flags);
      if (body === undefined) throw new UsageError("Provide the page body with --body or --body-file");
      const client = new AtlassianClient(await loadConfig());
      const result = await client.createConfluencePage(
        {
          title: flags.title,
          parentId: flags.parent,
          space: flags.space,
          body: { value: body, format: parseBodyFormat(flags.format) },
          draft: flags.draft,
          labels: flags.label,
        },
        { dryRun: flags["dry-run"] }
      );
      console.log(flags.json ? JSON.stringify(result, null, 2) : formatCreate(result));
      // The page exists but some labels did not stick; exit non-zero without inviting a second create.
      if (result.status === "created_with_errors") process.exit(1);
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});
