import { buildCommand } from "@stricli/core";
import { AtlassianClient, loadConfig } from "@atlassian-ai-toolkit/sdk";
import { parseBodyFormat } from "../body.js";
import { formatPage } from "../confluence-format.js";
import { UsageError, handleError } from "../errors.js";

interface GetFlags {
  readonly format?: string;
  readonly outline: boolean;
  readonly section: readonly string[];
  readonly meta: boolean;
  readonly full: boolean;
  readonly draft: boolean;
  readonly json: boolean;
}

export const confluenceGetCommand = buildCommand({
  docs: {
    brief: "Read a Confluence page: metadata, version, and body as markdown, storage, or ADF",
    fullDescription: [
      "Prints id, title, space, status, version (pass it to `edit --expect-version`), parent, and url,",
      "then the body. Bodies over 12,000 chars print the outline with section sizes instead.",
      "Content markdown cannot express shows as [[cf:kind ...]] and is counted on the `lossy:` line.",
      "A section runs from its heading to the next heading of the same or a higher level; a repeated",
      'heading is selected by path ("Setup > Install") or occurrence ("Setup > Install [2]").',
      "",
      "Examples:",
      '  atlassian confluence get 123456 --section "Release steps"',
      "  atlassian confluence get 123456 --outline --json",
    ].join("\n"),
  },
  parameters: {
    flags: {
      format: { kind: "parsed", parse: String, brief: "Body format: markdown (default), storage, or adf", optional: true },
      outline: { kind: "boolean", brief: "Headings and section sizes only", default: false },
      section: { kind: "parsed", parse: String, brief: "Return one section by heading, path, or path [n]; repeatable", variadic: true, default: [] },
      meta: { kind: "boolean", brief: "Metadata only, no body", default: false },
      full: { kind: "boolean", brief: "Return the whole body even when it is over the size guard", default: false },
      draft: { kind: "boolean", brief: "Read the unpublished draft when one exists", default: false },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
    positional: { kind: "tuple", parameters: [{ brief: "Page ID", parse: String, placeholder: "page-id" }] },
  },
  async func(this: void, flags: GetFlags, pageId: string) {
    try {
      const chosen = [flags.outline, flags.section.length > 0, flags.meta, flags.full].filter(Boolean).length;
      if (chosen > 1) throw new UsageError("Pass at most one of --outline, --section, --meta, --full");
      const client = new AtlassianClient(await loadConfig());
      const page = await client.getConfluencePageContent(pageId, {
        format: parseBodyFormat(flags.format),
        outline: flags.outline,
        sections: flags.section,
        meta: flags.meta,
        full: flags.full,
        draft: flags.draft,
      });
      console.log(flags.json ? JSON.stringify(page, null, 2) : formatPage(page));
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});
