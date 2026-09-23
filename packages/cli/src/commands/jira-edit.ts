import { readFile } from "node:fs/promises";
import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";
import type { JiraIssueEditEntry, JiraIssueFieldEdits } from "@atlassian-ai-toolkit/sdk";
import { handleError } from "../errors.js";
import { formatResolved, parseFieldFlags } from "../fields.js";

interface EditFlags {
  readonly field: readonly string[];
  readonly "from-file"?: string;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly notify: boolean;
}

function parseEditsFile(raw: string, path: string): JiraIssueFieldEdits[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} must be an array of { "key": "PROJ-1", "fields": { ... } } entries`);

  return parsed.map((entry, index) => {
    const record = entry as { key?: unknown; fields?: unknown };
    if (typeof record?.key !== "string" || record.key.trim().length === 0) throw new Error(`${path} entry ${index} is missing a "key" string`);
    if (typeof record.fields !== "object" || record.fields === null || Array.isArray(record.fields)) {
      throw new Error(`${path} entry ${index} ("${record.key}") is missing a "fields" object`);
    }
    return { key: record.key, fields: record.fields as Record<string, unknown> };
  });
}

function formatEntry(entry: JiraIssueEditEntry): string {
  if (entry.status === "error") return `- ${entry.key}: error ${entry.code}: ${entry.message}`;
  return `- ${entry.key}: ${entry.status}`;
}

export const jiraEditCommand = buildCommand({
  docs: {
    brief: "Set fields on a Jira issue; --dry-run previews the resolved payload",
  },
  parameters: {
    flags: {
      field: {
        kind: "parsed",
        parse: String,
        brief: "Field assignment as <id|name>=<value>; repeatable",
        variadic: true,
        default: [],
      },
      "from-file": {
        kind: "parsed",
        parse: String,
        brief: 'JSON file of [{ "key": "PROJ-1", "fields": { ... } }] edits',
        optional: true,
      },
      "dry-run": {
        kind: "boolean",
        brief: "Print the resolved field payload without sending it",
        default: false,
      },
      notify: {
        kind: "boolean",
        brief: "Notify watchers of the edit",
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
      parameters: [{ brief: "Issue key or ID; omit when using --from-file", parse: String, optional: true }],
    },
  },
  async func(this: void, flags: EditFlags, issueIdOrKey?: string) {
    try {
      const fromFile = flags["from-file"];
      const opts = { dryRun: flags["dry-run"], notifyUsers: flags.notify };
      const client = new AtlassianClient(resolveConfig());

      if (fromFile !== undefined) {
        if (issueIdOrKey !== undefined) throw new Error("Pass either an issue key or --from-file, not both");
        if (flags.field.length > 0) throw new Error("Pass either --field or --from-file, not both");

        const edits = parseEditsFile(await readFile(fromFile, "utf8"), fromFile);
        const batch = await client.editJiraIssues(edits, opts);
        const status = batch.failed > 0 ? "partial" : flags["dry-run"] ? "dry_run" : "updated";
        const result = { status, updated: batch.updated, failed: batch.failed, results: batch.results };
        const text = [`status: ${status}`, `updated: ${batch.updated}`, `failed: ${batch.failed}`, ...batch.results.map(formatEntry)].join("\n");
        console.log(flags.json ? JSON.stringify(result, null, 2) : text);
        // Every key was attempted; a partial failure still has to fail the command.
        if (batch.failed > 0) process.exit(1);
        return;
      }

      if (issueIdOrKey === undefined) throw new Error("Provide an issue key, or --from-file for a batch of edits");
      if (flags.field.length === 0) throw new Error("Provide at least one --field <id|name>=<value>");

      const result = await client.editJiraIssue(issueIdOrKey, parseFieldFlags(flags.field), opts);
      const text = [`status: ${result.status}`, `issue: ${result.key}`, ...formatResolved(result.resolved)].join("\n");
      console.log(flags.json ? JSON.stringify(result, null, 2) : text);
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});
