import { buildCommand } from "@stricli/core";
import { AtlassianClient, CONFLUENCE_SEARCH_FIELDS, loadConfig } from "@atlassian-ai-toolkit/sdk";
import type { ConfluenceSearchField } from "@atlassian-ai-toolkit/sdk";
import { parsePositiveInt } from "../body.js";
import { formatSearch } from "../confluence-format.js";
import { UsageError, handleError } from "../errors.js";

interface SearchFlags {
  readonly cql?: string;
  readonly text?: string;
  readonly space?: string;
  readonly type?: string;
  readonly limit?: string;
  readonly cursor?: string;
  readonly fields?: string;
  readonly excerpt?: string;
  readonly json: boolean;
}

function parseFields(value: string | undefined): ConfluenceSearchField[] | undefined {
  if (value === undefined) return undefined;
  const fields = value.split(",").map((field) => field.trim()).filter(Boolean);
  const unknown = fields.filter((field) => !(CONFLUENCE_SEARCH_FIELDS as readonly string[]).includes(field));
  if (fields.length === 0 || unknown.length > 0) {
    throw new UsageError(`--fields takes a comma-separated list of: ${CONFLUENCE_SEARCH_FIELDS.join(", ")}`, undefined, CONFLUENCE_SEARCH_FIELDS);
  }
  return fields as ConfluenceSearchField[];
}

function parseExcerpt(value: string | undefined): "none" | "short" | "full" | undefined {
  if (value === undefined || value === "none" || value === "short" || value === "full") return value;
  throw new UsageError(`--excerpt must be none, short, or full (got: "${value}")`, undefined, ["none", "short", "full"]);
}

export const confluenceSearchCommand = buildCommand({
  docs: {
    brief: "Search Confluence with CQL, or with --text and an optional --space",
    fullDescription: [
      "Default fields: id, title, space, type, modified (ISO date), excerpt (90 chars, highlights removed).",
      `--fields picks from: ${CONFLUENCE_SEARCH_FIELDS.join(", ")}.`,
      '--text builds `siteSearch ~ "<words>" AND type = page`, plus `space = "<KEY>"` with --space.',
      "The first line reports the count, the total, and `more: --cursor <c>` when more results exist.",
      "",
      "Examples:",
      '  atlassian confluence search --text "release checklist" --space ENG',
      '  atlassian confluence search --cql "label = runbook AND space = OPS" --limit 25 --fields id,title,url',
    ].join("\n"),
  },
  parameters: {
    flags: {
      cql: { kind: "parsed", parse: String, brief: "CQL query", optional: true },
      text: { kind: "parsed", parse: String, brief: "Words to search for, instead of --cql", optional: true },
      space: { kind: "parsed", parse: String, brief: "Space key to narrow --text", optional: true },
      type: { kind: "parsed", parse: String, brief: "Content type for --text (default page)", optional: true },
      limit: { kind: "parsed", parse: String, brief: "Results per page (default 10)", optional: true },
      cursor: { kind: "parsed", parse: String, brief: "Cursor from a previous page's `more:`", optional: true },
      fields: { kind: "parsed", parse: String, brief: "Comma-separated fields to return", optional: true },
      excerpt: { kind: "parsed", parse: String, brief: "Excerpt length: none, short (default), or full", optional: true },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
  },
  async func(this: void, flags: SearchFlags) {
    try {
      if ((flags.cql === undefined) === (flags.text === undefined)) throw new UsageError("Pass exactly one of --cql or --text");
      if (flags.cql !== undefined && (flags.space !== undefined || flags.type !== undefined)) throw new UsageError("--space and --type narrow --text; put them in the CQL instead");
      const options = {
        cql: flags.cql,
        text: flags.text,
        space: flags.space,
        type: flags.type,
        limit: parsePositiveInt(flags.limit, "--limit"),
        cursor: flags.cursor,
        fields: parseFields(flags.fields),
        excerpt: parseExcerpt(flags.excerpt),
      };
      const result = await new AtlassianClient(await loadConfig()).searchConfluence(options);
      console.log(flags.json ? JSON.stringify(result, null, 2) : formatSearch(result));
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});
