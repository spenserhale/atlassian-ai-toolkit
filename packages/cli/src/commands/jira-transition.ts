import { buildCommand } from "@stricli/core";
import { AtlassianClient, loadConfig } from "@atlassian-ai-toolkit/sdk";
import type { JiraTransitionSummary } from "@atlassian-ai-toolkit/sdk";
import { handleError } from "../errors.js";
import { formatResolved, parseFieldFlags } from "../fields.js";

interface TransitionFlags {
  readonly to?: string;
  readonly field: readonly string[];
  readonly "dry-run": boolean;
  readonly json: boolean;
}

function formatFieldList(fields: JiraTransitionSummary["fields"], required: JiraTransitionSummary["requiredFields"]): string {
  const requiredIds = new Set(required.map((field) => field.id));
  return fields.map((field) => `${field.id}${field.name ? ` (${field.name})` : ""}${requiredIds.has(field.id) ? "*" : ""}`).join(", ");
}

function formatTransition(transition: JiraTransitionSummary): string[] {
  const lines = [`- ${transition.id}  ${transition.name}  -> ${transition.to.name}${transition.to.category ? ` [${transition.to.category}]` : ""}`];
  if (transition.fields.length > 0) lines.push(`    fields: ${formatFieldList(transition.fields, transition.requiredFields)}`);
  return lines;
}

export const jiraTransitionCommand = buildCommand({
  docs: {
    brief: "List an issue's available transitions, or move it with --to; --dry-run previews",
    fullDescription: [
      "Without --to, lists the transitions available from the issue's current status: id, name, target",
      "status, and the fields on each transition screen (* marks required).",
      "",
      "With --to, moves the issue. --to takes a transition id, transition name, or target status name",
      "(case-insensitive). --field fills transition screen fields with the same id/name resolution and",
      "value coercion as `jira edit`, e.g. --field resolution=Done.",
    ].join("\n"),
  },
  parameters: {
    flags: {
      to: {
        kind: "parsed",
        parse: String,
        brief: "Transition id, transition name, or target status to move the issue to",
        optional: true,
      },
      field: {
        kind: "parsed",
        parse: String,
        brief: "Transition screen field as <id|name>=<value>; repeatable",
        variadic: true,
        default: [],
      },
      "dry-run": {
        kind: "boolean",
        brief: "Resolve the transition and field payload without moving the issue",
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
      parameters: [{ brief: "Issue key or ID", parse: String, placeholder: "key" }],
    },
  },
  async func(this: void, flags: TransitionFlags, issueIdOrKey: string) {
    try {
      if (flags.to === undefined) {
        if (flags.field.length > 0) throw new Error("--field needs --to <transition>");
        if (flags["dry-run"]) throw new Error("--dry-run needs --to <transition>");
      }
      const fields = parseFieldFlags(flags.field);
      const client = new AtlassianClient(await loadConfig());

      if (flags.to === undefined) {
        const transitions = await client.listJiraIssueTransitions(issueIdOrKey);
        if (flags.json) {
          console.log(JSON.stringify({ issue: issueIdOrKey, transitions }, null, 2));
          return;
        }
        const lines = transitions.length > 0 ? transitions.flatMap(formatTransition) : ["(no transitions available)"];
        console.log([`issue: ${issueIdOrKey}`, "transitions:", ...lines].join("\n"));
        return;
      }

      const result = await client.transitionJiraIssue(issueIdOrKey, { to: flags.to, fields }, { dryRun: flags["dry-run"] });
      const text = [
        `status: ${result.status}`,
        `issue: ${result.key}`,
        `transition: ${result.transition.id} ${result.transition.name} -> ${result.transition.to.name}`,
        ...formatResolved(result.resolved),
      ].join("\n");
      console.log(flags.json ? JSON.stringify(result, null, 2) : text);
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});
