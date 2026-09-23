import { readFile } from "node:fs/promises";
import { buildCommand } from "@stricli/core";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";
import type { JiraIssueCreateEntry, JiraIssueCreateInput } from "@atlassian-ai-toolkit/sdk";
import { handleError } from "../errors.js";
import { formatResolved, parseFieldFlags } from "../fields.js";

interface CreateFlags {
  readonly project?: string;
  readonly type?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly "description-file"?: string;
  readonly parent?: string;
  readonly field: readonly string[];
  readonly "from-file"?: string;
  readonly "dry-run": boolean;
  readonly json: boolean;
}

/** Keys a record may carry. Anything else belongs in `fields` and is refused rather than dropped. */
const RECORD_KEYS = new Set(["project", "issuetype", "issueType", "type", "summary", "description", "parent", "fields"]);

function readRecordString(record: Record<string, unknown>, keys: readonly string[], label: string, index: number): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    // A project id is a number in Jira's own payloads, so it is accepted and stringified rather
    // than dropped into a silent fallback to the default project.
    if (typeof value === "number") return String(value);
    if (typeof value !== "string") throw new Error(`${label} entry ${index} has a "${key}" value that is not a string`);
    if (value.trim().length > 0) return value;
  }
  return undefined;
}

function parseCreateFile(raw: string, path: string): JiraIssueCreateInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must be an array of { "project": "PROJ", "issuetype": "Bug", "fields": { ... } } entries`);
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${path} entry ${index} must be an object`);
    const record = entry as Record<string, unknown>;

    const unsupported = Object.keys(record).filter((key) => !RECORD_KEYS.has(key));
    if (unsupported.length > 0) {
      throw new Error(`${path} entry ${index} has unsupported key${unsupported.length > 1 ? "s" : ""} ${unsupported.join(", ")}; put field values under "fields"`);
    }

    const issueType = readRecordString(record, ["issuetype", "issueType", "type"], path, index);
    if (issueType === undefined) throw new Error(`${path} entry ${index} is missing an "issuetype" string`);
    if (record.fields !== undefined && (typeof record.fields !== "object" || record.fields === null || Array.isArray(record.fields))) {
      throw new Error(`${path} entry ${index} has a "fields" value that is not an object`);
    }

    const fields: Record<string, unknown> = { ...(record.fields as Record<string, unknown> | undefined) };
    // A description already in ADF is an object, which only the field path can carry.
    const adfDescription = typeof record.description === "object" && record.description !== null;
    if (adfDescription) fields.description = record.description;

    return {
      project: readRecordString(record, ["project"], path, index),
      issueType,
      summary: readRecordString(record, ["summary"], path, index),
      description: adfDescription ? undefined : readRecordString(record, ["description"], path, index),
      parent: readRecordString(record, ["parent"], path, index),
      fields,
    };
  });
}

function formatEntry(entry: JiraIssueCreateEntry): string {
  if (entry.status === "error") return `- ${entry.index}: error ${entry.code}: ${entry.message}`;
  return `- ${entry.index}: ${entry.status}${entry.key !== undefined ? ` ${entry.key}` : ""}${entry.url !== undefined ? ` ${entry.url}` : ""}`;
}

async function resolveDescription(flags: CreateFlags): Promise<string | undefined> {
  const path = flags["description-file"];
  if (flags.description !== undefined && path !== undefined) throw new Error("Pass either --description or --description-file, not both");
  if (path !== undefined) return readFile(path, "utf8");
  return flags.description;
}

export const jiraCreateCommand = buildCommand({
  docs: {
    brief: "Create a Jira issue; --dry-run previews the resolved payload",
  },
  parameters: {
    flags: {
      project: {
        kind: "parsed",
        parse: String,
        brief: "Project key or ID; defaults to ATLASSIAN_JIRA_PROJECT",
        optional: true,
      },
      type: {
        kind: "parsed",
        parse: String,
        brief: "Issue type display name or ID, resolved against the project",
        optional: true,
      },
      summary: {
        kind: "parsed",
        parse: String,
        brief: "Issue summary",
        optional: true,
      },
      description: {
        kind: "parsed",
        parse: String,
        brief: "Issue description as markdown; converted to ADF",
        optional: true,
      },
      "description-file": {
        kind: "parsed",
        parse: String,
        brief: "Read the markdown description from a file",
        optional: true,
      },
      parent: {
        kind: "parsed",
        parse: String,
        brief: "Parent issue key, for a sub-task or an issue under an epic",
        optional: true,
      },
      field: {
        kind: "parsed",
        parse: String,
        brief: "Field assignment as <id|name>=<value>; repeatable, comma-separated for lists",
        variadic: true,
        default: [],
      },
      "from-file": {
        kind: "parsed",
        parse: String,
        brief: 'JSON file of [{ "project": "PROJ", "issuetype": "Bug", "fields": { ... } }] issues',
        optional: true,
      },
      "dry-run": {
        kind: "boolean",
        brief: "Print the resolved create payload without sending it",
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
      parameters: [],
    },
  },
  async func(this: void, flags: CreateFlags) {
    try {
      const fromFile = flags["from-file"];
      const opts = { dryRun: flags["dry-run"] };
      const client = new AtlassianClient(resolveConfig());

      if (fromFile !== undefined) {
        const singleIssueFlags = [
          ["--type", flags.type],
          ["--summary", flags.summary],
          ["--description", flags.description],
          ["--description-file", flags["description-file"]],
          ["--parent", flags.parent],
          ["--field", flags.field.length > 0 ? "set" : undefined],
        ] as const;
        const conflicting = singleIssueFlags.filter(([, value]) => value !== undefined).map(([name]) => name);
        if (conflicting.length > 0) {
          throw new Error(`Pass either --from-file or the single-issue flags, not both (got: ${conflicting.join(", ")}); --project is the batch default`);
        }

        const inputs = parseCreateFile(await readFile(fromFile, "utf8"), fromFile);
        const batch = await client.createJiraIssues(
          flags.project === undefined ? inputs : inputs.map((input) => ({ ...input, project: input.project ?? flags.project })),
          opts
        );
        const status = batch.failed > 0 ? (batch.created > 0 ? "partial" : "error") : flags["dry-run"] ? "dry_run" : "created";
        const result = { status, created: batch.created, failed: batch.failed, results: batch.results };
        const text = [`status: ${status}`, `created: ${batch.created}`, `failed: ${batch.failed}`, ...batch.results.map(formatEntry)].join("\n");
        console.log(flags.json ? JSON.stringify(result, null, 2) : text);
        // Every record was attempted; a partial failure still has to fail the command.
        if (batch.failed > 0) process.exit(1);
        return;
      }

      if (flags.type === undefined) throw new Error("Provide --type <name|id>, or --from-file for a batch of issues");
      if (flags.summary === undefined) throw new Error("Provide --summary <text>");

      const result = await client.createJiraIssue(
        {
          project: flags.project,
          issueType: flags.type,
          summary: flags.summary,
          description: await resolveDescription(flags),
          parent: flags.parent,
          fields: parseFieldFlags(flags.field),
        },
        opts
      );

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const lines = [`status: ${result.status}`, `project: ${result.project}`, `type: ${result.issueType.name}`];
      if (result.key !== undefined) lines.push(`issue: ${result.key}`);
      if (result.id !== undefined) lines.push(`id: ${result.id}`);
      if (result.url !== undefined) lines.push(`url: ${result.url}`);
      lines.push(...formatResolved(result.resolved));
      // A dry run has to show everything the real create would send, so the payload prints too.
      if (result.status === "dry_run") lines.push(`payload: ${JSON.stringify({ fields: result.fields })}`);
      console.log(lines.join("\n"));
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});
