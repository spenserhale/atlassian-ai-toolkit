import { buildCommand, buildRouteMap } from "@stricli/core";
import {
  AtlassianAuthError,
  AtlassianClient,
  AtlassianError,
  AtlassianNotFoundError,
  AtlassianRateLimitError,
  JIRA_SPRINT_ISSUE_MOVE_LIMIT,
  resolveConfig,
} from "@atlassian-ai-toolkit/sdk";
import type {
  JiraIssue,
  JiraSprintIssueMoveResult,
  JiraSprintState,
  MoveJiraSprintIssuesInput,
  UpdateJiraSprintInput,
} from "@atlassian-ai-toolkit/sdk";

const sprintStates = ["future", "active", "closed"] as const;

interface JsonFlag {
  readonly json: boolean;
}

interface ListFlags extends JsonFlag {
  readonly board: string;
  readonly state?: string;
}

interface CreateFlags extends JsonFlag {
  readonly board: string;
  readonly name: string;
  readonly goal?: string;
  readonly "start-date"?: string;
  readonly "end-date"?: string;
}

interface EditFlags extends JsonFlag {
  readonly name?: string;
  readonly goal?: string;
  readonly "start-date"?: string;
  readonly "end-date"?: string;
  readonly state?: string;
}

interface CloseFlags extends JsonFlag {
  readonly confirm?: string;
  readonly "dry-run": boolean;
  readonly force: boolean;
  readonly issues?: string;
  readonly "move-to-backlog": boolean;
  readonly "move-to-sprint"?: string;
}

interface RolloverFlags extends JsonFlag {
  readonly confirm?: string;
  readonly "dry-run": boolean;
  readonly force: boolean;
  readonly issues: string;
  readonly "move-to-backlog": boolean;
  readonly "move-to-sprint"?: string;
}

function getClient(): AtlassianClient {
  return new AtlassianClient(resolveConfig());
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer (got: "${value}")`);
  return parsed;
}

function parseState(value: string | undefined): JiraSprintState | undefined {
  if (value === undefined) return undefined;
  if (sprintStates.includes(value as JiraSprintState)) return value as JiraSprintState;
  throw new Error(`--state must be one of: ${sprintStates.join(", ")} (got: "${value}")`);
}

function parseEditableState(value: string | undefined): JiraSprintState | undefined {
  const state = parseState(value);
  if (state === "closed") throw new Error('Use "jira sprint close" to close a sprint so confirmation safeguards are applied');
  return state;
}

function parseIssues(value: string | undefined): string[] {
  const issues = value?.split(",").map((issue) => issue.trim()).filter(Boolean) ?? [];
  if (issues.length === 0) throw new Error("--issues must include at least one issue key, for example: --issues PROJ-1,PROJ-2");
  return issues;
}

function buildMoveInput(flags: Pick<CloseFlags, "issues" | "move-to-backlog" | "move-to-sprint">): MoveJiraSprintIssuesInput | undefined {
  const hasSprintTarget = flags["move-to-sprint"] !== undefined;
  if (hasSprintTarget && flags["move-to-backlog"]) throw new Error("Use only one rollover target: --move-to-sprint or --move-to-backlog");
  if (flags.issues !== undefined && !hasSprintTarget && !flags["move-to-backlog"]) throw new Error("--issues requires a rollover target: --move-to-sprint or --move-to-backlog");
  if (!hasSprintTarget && !flags["move-to-backlog"]) return undefined;

  const issueKeys = parseIssues(flags.issues);
  if (flags["move-to-backlog"]) return { issueKeys, target: "backlog" };
  return { issueKeys, targetSprintId: parseNumber(flags["move-to-sprint"] ?? "", "--move-to-sprint") };
}

function formatSprint(sprint: { id: number; name: string; state: string; goal?: string }): string {
  const lines = [`id: ${sprint.id}`, `name: ${sprint.name}`, `state: ${sprint.state}`];
  if (sprint.goal) lines.push(`goal: ${sprint.goal}`);
  return lines.join("\n");
}

function formatIssue(issue: JiraIssue): string {
  const summary = typeof issue.fields?.summary === "string" ? issue.fields.summary : "";
  const status = issue.fields?.status;
  const statusName = typeof status === "object" && status !== null && typeof (status as { name?: unknown }).name === "string"
    ? ` (${(status as { name: string }).name})`
    : "";
  return `- ${issue.key}: ${summary}${statusName}`;
}

function printResult(value: unknown, json: boolean, text: string): void {
  console.log(json ? JSON.stringify(value, null, 2) : text);
}

function planBatches(issueKeys: readonly string[]): number {
  return Math.ceil(issueKeys.length / JIRA_SPRINT_ISSUE_MOVE_LIMIT);
}

function errorCode(err: unknown): string {
  if (err instanceof AtlassianAuthError) return "auth_error";
  if (err instanceof AtlassianNotFoundError) return "not_found";
  if (err instanceof AtlassianRateLimitError) return "rate_limited";
  if (err instanceof AtlassianError) return "upstream_error";
  return "usage_error";
}

function handleError(err: unknown, json: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.log(JSON.stringify({ status: "error", code: errorCode(err), message }, null, 2));
  } else {
    console.error(`error: ${message}`);
  }
  process.exit(1);
}

/** Fails the process reporting how much of a rollover landed, without closing the sprint. */
function reportMoveFailure(json: boolean, sprintLabel: Record<string, unknown>, moveResult: JiraSprintIssueMoveResult, totalRequested: number): never {
  const message = `Rollover failed after moving ${moveResult.moved} of ${totalRequested} issues.`;
  const hint = "Re-run the same command — issue moves are idempotent, so already-moved issues are unaffected.";
  const result = {
    status: "error",
    code: "sprint_move_failed",
    ...sprintLabel,
    batches: moveResult.batches,
    moved: moveResult.moved,
    failed: moveResult.failed,
    message,
    hint,
  };
  printResult(result, json, `status: error\ncode: sprint_move_failed\n${message}\n${hint}`);
  process.exit(1);
}

const getCommand = buildCommand({
  docs: { brief: "Get a Jira sprint by ID" },
  parameters: {
    flags: {
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Sprint ID", parse: String }],
    },
  },
  async func(this: void, flags: JsonFlag, sprintId: string) {
    try {
      const sprint = await getClient().getJiraSprint(sprintId);
      printResult(sprint, flags.json, formatSprint(sprint));
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});

const listCommand = buildCommand({
  docs: { brief: "List Jira sprints for a board" },
  parameters: {
    flags: {
      board: { kind: "parsed", parse: String, brief: "Board ID" },
      state: { kind: "parsed", parse: String, brief: "Filter by state: future, active, or closed", optional: true },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
  },
  async func(this: void, flags: ListFlags) {
    try {
      const result = await getClient().listJiraSprints(parseNumber(flags.board, "--board"), {
        state: parseState(flags.state),
      });
      const text = [`sprints[${result.values.length}]:`, ...result.values.map((sprint) => `- ${sprint.id}: ${sprint.name} (${sprint.state})`)].join("\n");
      printResult(result, flags.json, text);
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});

const issuesCommand = buildCommand({
  docs: { brief: "List issues in a Jira sprint" },
  parameters: {
    flags: {
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Sprint ID", parse: String }],
    },
  },
  async func(this: void, flags: JsonFlag, sprintId: string) {
    try {
      const result = await getClient().listJiraSprintIssues(sprintId);
      const text = [`issues[${result.issues.length}]:`, ...result.issues.map(formatIssue)].join("\n");
      printResult(result, flags.json, text);
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});

const createCommand = buildCommand({
  docs: { brief: "Create a future Jira sprint" },
  parameters: {
    flags: {
      board: { kind: "parsed", parse: String, brief: "Origin board ID" },
      name: { kind: "parsed", parse: String, brief: "Sprint name" },
      goal: { kind: "parsed", parse: String, brief: "Sprint goal", optional: true },
      "start-date": { kind: "parsed", parse: String, brief: "Sprint start date", optional: true },
      "end-date": { kind: "parsed", parse: String, brief: "Sprint end date", optional: true },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
  },
  async func(this: void, flags: CreateFlags) {
    try {
      const sprint = await getClient().createJiraSprint({
        originBoardId: parseNumber(flags.board, "--board"),
        name: flags.name,
        goal: flags.goal,
        startDate: flags["start-date"],
        endDate: flags["end-date"],
      });
      printResult({ status: "created", sprint }, flags.json, `status: created\n${formatSprint(sprint)}`);
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});

const editCommand = buildCommand({
  docs: { brief: "Edit a Jira sprint" },
  parameters: {
    flags: {
      name: { kind: "parsed", parse: String, brief: "Sprint name", optional: true },
      goal: { kind: "parsed", parse: String, brief: "Sprint goal", optional: true },
      "start-date": { kind: "parsed", parse: String, brief: "Sprint start date", optional: true },
      "end-date": { kind: "parsed", parse: String, brief: "Sprint end date", optional: true },
      state: { kind: "parsed", parse: String, brief: "Sprint state: future or active; use close to close a sprint", optional: true },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Sprint ID", parse: String }],
    },
  },
  async func(this: void, flags: EditFlags, sprintId: string) {
    try {
      const input: UpdateJiraSprintInput = {
        name: flags.name,
        goal: flags.goal,
        startDate: flags["start-date"],
        endDate: flags["end-date"],
        state: parseEditableState(flags.state),
      };
      if (Object.values(input).every((value) => value === undefined)) throw new Error("Provide at least one field to edit");

      const sprint = await getClient().updateJiraSprint(sprintId, input);
      printResult({ status: "updated", sprint }, flags.json, `status: updated\n${formatSprint(sprint)}`);
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});

const closeCommand = buildCommand({
  docs: { brief: "Close a Jira sprint; previews unless --force is set" },
  parameters: {
    flags: {
      confirm: { kind: "parsed", parse: String, brief: "Sprint ID required with --force", optional: true },
      "dry-run": { kind: "boolean", brief: "Show what would change without changing it", default: false },
      force: { kind: "boolean", brief: "Required to close the sprint", default: false },
      issues: { kind: "parsed", parse: String, brief: "Comma-separated issue keys to roll over before closing", optional: true },
      "move-to-backlog": { kind: "boolean", brief: "Move listed issues to the backlog before closing", default: false },
      "move-to-sprint": { kind: "parsed", parse: String, brief: "Move listed issues to another sprint before closing", optional: true },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Sprint ID", parse: String }],
    },
  },
  async func(this: void, flags: CloseFlags, sprintId: string) {
    try {
      const client = getClient();
      const moveInput = buildMoveInput(flags);
      const sprint = await client.getJiraSprint(sprintId);
      const batches = moveInput ? planBatches(moveInput.issueKeys) : 0;
      const preview = {
        status: "dry_run",
        wouldClose: { id: sprint.id, name: sprint.name, state: sprint.state },
        rollover: moveInput,
        batches,
        issueCount: moveInput?.issueKeys.length ?? 0,
        hint: `Pass --force --confirm ${sprint.id} to close this Jira sprint.`,
      };

      if (flags["dry-run"] || !flags.force) {
        printResult(preview, flags.json, `status: dry_run\nwould_close: ${sprint.id}\nbatches: ${batches}\nhint: ${preview.hint}`);
        return;
      }

      if (flags.confirm !== String(sprint.id)) {
        const result = {
          status: "confirmation_required",
          sprint: { id: sprint.id, name: sprint.name, state: sprint.state },
          hint: `Re-run with --force --confirm ${sprint.id} to close this Jira sprint.`,
        };
        printResult(result, flags.json, `status: confirmation_required\nsprint: ${sprint.id}\nhint: ${result.hint}`);
        process.exit(2);
      }

      let moveResult: JiraSprintIssueMoveResult | undefined;
      if (moveInput) {
        moveResult = await client.moveJiraSprintIssues(moveInput);
        if (moveResult.failed.length > 0) {
          reportMoveFailure(flags.json, { sprint: { id: sprint.id, name: sprint.name, state: sprint.state } }, moveResult, moveInput.issueKeys.length);
        }
      }

      const closed = await client.updateJiraSprint(sprint.id, { state: "closed" });
      printResult(
        { status: "closed", sprint: closed, rollover: moveInput, batches: moveResult?.batches ?? 0, moved: moveResult?.moved ?? 0, failed: [] },
        flags.json,
        `status: closed\n${formatSprint(closed)}`
      );
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});

const rolloverCommand = buildCommand({
  docs: { brief: "Move Jira sprint issues to another sprint or the backlog" },
  parameters: {
    flags: {
      confirm: { kind: "parsed", parse: String, brief: "Sprint ID required with --force", optional: true },
      "dry-run": { kind: "boolean", brief: "Show what would change without changing it", default: false },
      force: { kind: "boolean", brief: "Required to move issues", default: false },
      issues: { kind: "parsed", parse: String, brief: "Comma-separated issue keys to move" },
      "move-to-backlog": { kind: "boolean", brief: "Move issues to the backlog", default: false },
      "move-to-sprint": { kind: "parsed", parse: String, brief: "Move issues to another sprint", optional: true },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Source sprint ID", parse: String }],
    },
  },
  async func(this: void, flags: RolloverFlags, sprintId: string) {
    try {
      const client = getClient();
      const moveInput = buildMoveInput(flags);
      if (!moveInput) throw new Error("Provide one rollover target: --move-to-sprint or --move-to-backlog");
      const sprint = await client.getJiraSprint(sprintId);
      const batches = planBatches(moveInput.issueKeys);

      const preview = {
        status: "dry_run",
        sourceSprint: { id: sprint.id, name: sprint.name, state: sprint.state },
        rollover: moveInput,
        batches,
        issueCount: moveInput.issueKeys.length,
        hint: `Pass --force --confirm ${sprint.id} to move these Jira issues.`,
      };

      if (flags["dry-run"] || !flags.force) {
        printResult(preview, flags.json, `status: dry_run\nsource_sprint: ${sprint.id}\nbatches: ${batches}\nhint: ${preview.hint}`);
        return;
      }

      if (flags.confirm !== String(sprint.id)) {
        const result = {
          status: "confirmation_required",
          sprint: { id: sprint.id, name: sprint.name, state: sprint.state },
          hint: `Re-run with --force --confirm ${sprint.id} to move these Jira issues.`,
        };
        printResult(result, flags.json, `status: confirmation_required\nsprint: ${sprint.id}\nhint: ${result.hint}`);
        process.exit(2);
      }

      const moveResult = await client.moveJiraSprintIssues(moveInput);
      if (moveResult.failed.length > 0) {
        reportMoveFailure(flags.json, { sourceSprint: { id: sprint.id, name: sprint.name } }, moveResult, moveInput.issueKeys.length);
      }

      printResult(
        { status: "moved", sourceSprint: { id: sprint.id, name: sprint.name }, rollover: moveInput, batches: moveResult.batches, moved: moveResult.moved, failed: [] },
        flags.json,
        `status: moved\nsource_sprint: ${sprint.id}`
      );
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});

export const jiraSprintRoutes = buildRouteMap({
  routes: {
    get: getCommand,
    list: listCommand,
    issues: issuesCommand,
    create: createCommand,
    edit: editCommand,
    close: closeCommand,
    rollover: rolloverCommand,
  },
  docs: {
    brief: "Manage Jira sprints",
  },
});
