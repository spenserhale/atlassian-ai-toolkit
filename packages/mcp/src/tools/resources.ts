import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { AtlassianClient, AtlassianNotFoundError, JIRA_SPRINT_ISSUE_MOVE_LIMIT, loadConfig, loadCredentials, redactedConfig } from "@atlassian-ai-toolkit/sdk";
import type {
  ConfluenceEditOperation,
  JiraAttachmentUpload,
  JiraIssueCreateInput,
  JiraIssueFieldEdits,
  JiraSprintIssueMoveResult,
  JiraSprintPoints,
  JiraSprintState,
  MoveJiraSprintIssuesInput,
} from "@atlassian-ai-toolkit/sdk";

/**
 * Config is loaded per tool call, so a credential rotated in the OS keychain applies without
 * restarting the MCP host. There is deliberately no tool that writes or deletes keychain entries.
 */
async function getClient(): Promise<AtlassianClient> {
  const config = await loadConfig();
  return new AtlassianClient(config);
}

const sprintStateSchema = z.enum(["future", "active", "closed"]);

function buildMoveInput(args: { issueKeys?: string[]; moveToBacklog?: boolean; moveToSprintId?: number }): MoveJiraSprintIssuesInput | undefined {
  if (args.moveToBacklog && args.moveToSprintId !== undefined) throw new Error("Use only one rollover target: moveToSprintId or moveToBacklog");
  if (args.issueKeys !== undefined && !args.moveToBacklog && args.moveToSprintId === undefined) throw new Error("issueKeys requires a rollover target: moveToSprintId or moveToBacklog");
  if (!args.moveToBacklog && args.moveToSprintId === undefined) return undefined;
  if (!args.issueKeys?.length) throw new Error("issueKeys must include at least one issue key when rolling over issues");

  if (args.moveToBacklog) return { issueKeys: args.issueKeys, target: "backlog" };
  if (args.moveToSprintId === undefined) throw new Error("Provide one rollover target: moveToSprintId or moveToBacklog");
  return { issueKeys: args.issueKeys, targetSprintId: args.moveToSprintId };
}

/** Confirms a moveToSprintId target exists so dry-run previews don't echo back an invalid sprint id. */
async function validateRolloverTarget(client: AtlassianClient, moveInput: MoveJiraSprintIssuesInput | undefined): Promise<void> {
  if (!moveInput || !("targetSprintId" in moveInput)) return;
  try {
    await client.getJiraSprint(moveInput.targetSprintId);
  } catch (err) {
    if (err instanceof AtlassianNotFoundError) throw new Error(`moveToSprintId target ${moveInput.targetSprintId} does not exist`);
    throw err;
  }
}

function summarizeAttachments(result: { results: Array<{ id: string; title?: string; status?: string; _links?: Record<string, unknown> }> }) {
  return result.results.map((attachment) => ({
    id: attachment.id,
    title: attachment.title,
    status: attachment.status,
    links: attachment._links,
  }));
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} is required`);
  return value;
}

/** The rollup costs a full pass over the sprint, so it only runs when the caller asks for it. */
async function rollupPoints(client: AtlassianClient, sprintId: number, args: { includePoints?: boolean; pointsField?: string }): Promise<JiraSprintPoints | undefined> {
  if (args.includePoints !== true) return undefined;
  return client.getJiraSprintPoints(sprintId, { pointsField: args.pointsField });
}

function planBatches(issueKeys: readonly string[]): number {
  return Math.ceil(issueKeys.length / JIRA_SPRINT_ISSUE_MOVE_LIMIT);
}

/** Reports how much of a rollover landed, without closing the sprint. */
function moveFailureResult(sprintLabel: Record<string, unknown>, moveResult: JiraSprintIssueMoveResult, totalRequested: number): string {
  return JSON.stringify({
    status: "error",
    code: "sprint_move_failed",
    ...sprintLabel,
    batches: moveResult.batches,
    moved: moveResult.moved,
    failed: moveResult.failed,
    message: `Rollover failed after moving ${moveResult.moved} of ${totalRequested} issues.`,
    hint: "Call again — issue moves are idempotent, so already-moved issues are unaffected.",
  }, null, 2);
}

export function registerResourceTools(server: FastMCP) {
  server.addTool({
    name: "atlassian_config_status",
    description:
      "Report whether Atlassian credentials are configured and where each comes from (env, .env file, or OS keychain). Never returns credential values.",
    parameters: z.object({}),
    execute: async () => JSON.stringify(redactedConfig(await loadCredentials()), null, 2),
  });

  server.addTool({
    name: "jira_get_issue",
    description: "Get one Jira issue by key or id.",
    parameters: z.object({
      issueIdOrKey: z.string().describe("Jira issue key or id"),
    }),
    execute: async (args) => {
      const issue = await (await getClient()).getJiraIssue(args.issueIdOrKey);
      return JSON.stringify(issue, null, 2);
    },
  });

  server.addTool({
    name: "jira_delete_issue",
    description: "Preview or delete one Jira issue. Deletion requires force true and confirm matching the issue key or id.",
    parameters: z.object({
      issueIdOrKey: z.string().describe("Jira issue key or id"),
      deleteSubtasks: z.boolean().default(false).describe("Also delete subtasks"),
      force: z.boolean().default(false).describe("Must be true to delete"),
      confirm: z.string().optional().describe("Must match fetched issue key or id when force is true"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const issue = await client.getJiraIssue(args.issueIdOrKey);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          wouldDelete: { id: issue.id, key: issue.key, summary: issue.fields?.summary },
          deleteSubtasks: args.deleteSubtasks,
          hint: `Call again with force true and confirm "${issue.key}" to permanently delete this Jira issue.`,
        }, null, 2);
      }

      if (args.confirm !== issue.key && args.confirm !== issue.id) {
        return JSON.stringify({
          status: "confirmation_required",
          issue: { id: issue.id, key: issue.key, summary: issue.fields?.summary },
          hint: `Call again with force true and confirm "${issue.key}" to permanently delete this Jira issue.`,
        }, null, 2);
      }

      await client.deleteJiraIssue(args.issueIdOrKey, { deleteSubtasks: args.deleteSubtasks });
      return JSON.stringify({ status: "deleted", issue: { id: issue.id, key: issue.key }, deleteSubtasks: args.deleteSubtasks }, null, 2);
    },
  });

  server.addTool({
    name: "jira_search_issues",
    description:
      "Search Jira issues with JQL, auto-paginated. Returns matching issues plus total/isLast/startAt, where isLast is false when the walk stopped at limit. Use jira_list_sprint_issues when you need every issue in one sprint.",
    parameters: z.object({
      jql: z.string().min(1).describe("JQL query, for example: project = PROJ AND sprint = 42 AND status != Done"),
      limit: z.number().int().positive().optional().describe("Stop after this many issues"),
      fields: z.array(z.string()).optional().describe("Issue fields to return; defaults to *navigable"),
    }),
    execute: async (args) => {
      const result = await (await getClient()).searchJiraIssues(args.jql, {
        limit: args.limit,
        fields: args.fields,
      });
      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "jira_edit_issue",
    description:
      "Set fields on one Jira issue, or on a batch of issues. Field ids or display names are resolved against the issue's edit screen and values are coerced to the shape each field's schema requires, so pass plain values (\"Support\", 2, \"a,b\") rather than Jira payload objects. Set dryRun to validate and see the resolved payload without writing. A rejected field reports the issue's settable fields so the unsettable one can be dropped.",
    parameters: z.object({
      issueIdOrKey: z.string().optional().describe("Jira issue key or id; omit when using edits"),
      fields: z.record(z.unknown()).optional().describe("Field values keyed by field id or display name, for example { \"Task Category\": \"Support\", \"customfield_10105\": 2 }"),
      edits: z
        .array(
          z.object({
            key: z.string().min(1).describe("Jira issue key or id"),
            fields: z.record(z.unknown()).describe("Field values keyed by field id or display name"),
          })
        )
        .optional()
        .describe("Batch of per-issue edits; failures are reported per key and do not abort the batch"),
      dryRun: z.boolean().default(false).describe("Resolve and validate the payload without sending it"),
      notifyUsers: z.boolean().default(false).describe("Notify watchers of the edit"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const opts = { dryRun: args.dryRun, notifyUsers: args.notifyUsers };

      if (args.edits !== undefined && args.edits.length > 0) {
        if (args.issueIdOrKey !== undefined || args.fields !== undefined) throw new Error("Pass either issueIdOrKey with fields, or edits, not both");
        const batch = await client.editJiraIssues(args.edits as JiraIssueFieldEdits[], opts);
        return JSON.stringify({
          status: batch.failed > 0 ? "partial" : args.dryRun ? "dry_run" : "updated",
          ...batch,
        }, null, 2);
      }

      if (args.issueIdOrKey === undefined) throw new Error("Provide issueIdOrKey with fields, or edits for a batch");
      if (args.fields === undefined) throw new Error("Provide at least one field to edit");
      const result = await client.editJiraIssue(args.issueIdOrKey, args.fields, opts);
      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "jira_list_transitions",
    description:
      "List the workflow transitions available on a Jira issue from its current status: each transition's id, name, target status, and the fields on its transition screen (requiredFields marks the ones Jira requires). Use before jira_transition_issue to see which moves and screen fields exist.",
    parameters: z.object({
      issueIdOrKey: z.string().min(1).describe("Jira issue key or id"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const transitions = await client.listJiraIssueTransitions(args.issueIdOrKey);
      return JSON.stringify({ issue: args.issueIdOrKey, transitions }, null, 2);
    },
  });

  server.addTool({
    name: "jira_transition_issue",
    description:
      "Move a Jira issue to another status through a workflow transition. `to` takes a transition id, transition name, or target status name (case-insensitive). `fields` fills transition screen fields (for example { \"resolution\": \"Done\" }) with the same id/name resolution and value coercion as jira_edit_issue; only fields on the transition screen can be set. Set dryRun to validate and see the chosen transition and resolved payload without moving the issue. A `to` that matches no available transition fails with the available ones in the error details.",
    parameters: z.object({
      issueIdOrKey: z.string().min(1).describe("Jira issue key or id"),
      to: z.string().min(1).describe("Transition id, transition name, or target status name, for example \"Done\""),
      fields: z.record(z.unknown()).optional().describe("Transition screen field values keyed by field id or display name"),
      dryRun: z.boolean().default(false).describe("Resolve and validate without moving the issue"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const result = await client.transitionJiraIssue(args.issueIdOrKey, { to: args.to, fields: args.fields }, { dryRun: args.dryRun });
      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "jira_create_issue",
    description:
      "Create one Jira issue, or a batch of them. The issue type and every field are resolved against the project's create screen, so pass plain values (\"Bug\", \"Support\", 2, \"a,b\") rather than Jira payload objects, and a markdown description is converted to ADF. Set dryRun to see the full resolved payload without writing. Returns the new issue key, id, and browse URL. A rejected create reports the project's issue types, the required fields, or the settable fields, so the retry needs no extra metadata call.",
    parameters: z.object({
      project: z.string().optional().describe("Project key or id; defaults to ATLASSIAN_JIRA_PROJECT"),
      issueType: z.string().optional().describe("Issue type display name or id, for example Bug, Story, Sub-task"),
      summary: z.string().optional().describe("Issue summary"),
      description: z.string().optional().describe("Issue description as markdown; converted to ADF"),
      parent: z.string().optional().describe("Parent issue key, for a sub-task or an issue under an epic"),
      fields: z.record(z.unknown()).optional().describe("Other field values keyed by field id or display name, for example { \"Task Category\": \"Support\", \"Priority\": \"High\" }"),
      issues: z
        .array(
          z.object({
            project: z.string().optional().describe("Project key or id; defaults to ATLASSIAN_JIRA_PROJECT"),
            issueType: z.string().min(1).describe("Issue type display name or id"),
            summary: z.string().optional().describe("Issue summary"),
            description: z.string().optional().describe("Issue description as markdown"),
            parent: z.string().optional().describe("Parent issue key"),
            fields: z.record(z.unknown()).optional().describe("Other field values keyed by field id or display name"),
          })
        )
        .optional()
        .describe("Batch of issues to create; failures are reported per record and do not abort the batch"),
      dryRun: z.boolean().default(false).describe("Resolve and validate the payload without creating anything"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const opts = { dryRun: args.dryRun };

      if (args.issues !== undefined && args.issues.length > 0) {
        const conflicting = (["issueType", "summary", "description", "parent", "fields"] as const).filter((name) => args[name] !== undefined);
        if (conflicting.length > 0) {
          throw new Error(`Pass either a single issue or issues, not both (got: ${conflicting.join(", ")}); project is the batch default`);
        }
        // A top-level project is the default for records that do not name one, matching the CLI.
        const records = (args.issues as JiraIssueCreateInput[]).map((issue) => ({ ...issue, project: issue.project ?? args.project }));
        const batch = await client.createJiraIssues(records, opts);
        return JSON.stringify({
          status: batch.failed > 0 ? (batch.created > 0 ? "partial" : "error") : args.dryRun ? "dry_run" : "created",
          ...batch,
        }, null, 2);
      }

      if (args.issueType === undefined) throw new Error("Provide issueType, or issues for a batch");
      const result = await client.createJiraIssue(
        {
          project: args.project,
          issueType: args.issueType,
          summary: args.summary,
          description: args.description,
          parent: args.parent,
          fields: args.fields,
        },
        opts
      );
      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "jira_get_sprint",
    description:
      "Get one Jira sprint by id. Use this before editing or closing a sprint when you need the current state. Set includePoints for a committed/completed story point rollup.",
    parameters: z.object({
      sprintId: z.number().int().positive().describe("Jira sprint id"),
      includePoints: z.boolean().default(false).describe("Include a committed/completed story point rollup; costs one pass over the sprint"),
      pointsField: z.string().optional().describe("Story point field id; defaults to ATLASSIAN_STORY_POINTS_FIELD or customfield_10105"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const sprint = await client.getJiraSprint(args.sprintId);
      const points = await rollupPoints(client, sprint.id, args);
      return JSON.stringify(points === undefined ? sprint : { ...sprint, points }, null, 2);
    },
  });

  server.addTool({
    name: "jira_get_current_sprint",
    description:
      "Get the sprint currently running on a Jira board. Throws when the board has no active sprint. Set includePoints for a committed/completed story point rollup.",
    parameters: z.object({
      boardId: z.number().int().positive().optional().describe("Jira board id; defaults to ATLASSIAN_JIRA_BOARD_ID when omitted"),
      includePoints: z.boolean().default(false).describe("Include a committed/completed story point rollup; costs one pass over the sprint"),
      pointsField: z.string().optional().describe("Story point field id; defaults to ATLASSIAN_STORY_POINTS_FIELD or customfield_10105"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const sprint = await client.getCurrentJiraSprint(args.boardId);
      const points = await rollupPoints(client, sprint.id, args);
      return JSON.stringify(points === undefined ? sprint : { ...sprint, points }, null, 2);
    },
  });

  server.addTool({
    name: "jira_list_sprints",
    description: "List Jira sprints for a board, optionally filtered by state. Use to find active or future sprint ids.",
    parameters: z.object({
      boardId: z.number().int().positive().optional().describe("Jira board id; defaults to ATLASSIAN_JIRA_BOARD_ID when omitted"),
      state: sprintStateSchema.optional().describe("Optional sprint state filter"),
    }),
    execute: async (args) => {
      const sprints = await (await getClient()).listJiraSprints(args.boardId, {
        state: args.state,
      });
      return JSON.stringify(sprints, null, 2);
    },
  });

  server.addTool({
    name: "jira_list_sprint_issues",
    description:
      "List all issues in a Jira sprint, auto-paginated. Use to collect issue keys before rollover or closing a sprint.",
    parameters: z.object({
      sprintId: z.number().int().positive().describe("Jira sprint id"),
      fields: z.array(z.string()).optional().describe("Issue fields to return; defaults to every navigable field, which is large for a full sprint"),
    }),
    execute: async (args) => {
      const result = await (await getClient()).listJiraSprintIssues(args.sprintId, { fields: args.fields });
      return JSON.stringify(result, null, 2);
    },
  });

  server.addTool({
    name: "jira_create_sprint",
    description: "Create a future Jira sprint on a board. Returns the created sprint; no confirmation is required.",
    parameters: z.object({
      originBoardId: z.number().int().positive().optional().describe("Board where the sprint is created; defaults to ATLASSIAN_JIRA_BOARD_ID when omitted"),
      name: z.string().min(1).describe("Sprint name"),
      goal: z.string().optional().describe("Sprint goal"),
      startDate: z.string().optional().describe("Sprint start date as accepted by Jira"),
      endDate: z.string().optional().describe("Sprint end date as accepted by Jira"),
    }),
    execute: async (args) => {
      const sprint = await (await getClient()).createJiraSprint(args);
      return JSON.stringify({ status: "created", sprint }, null, 2);
    },
  });

  server.addTool({
    name: "jira_edit_sprint",
    description: "Edit Jira sprint metadata or state. Use for active or future sprint changes; use jira_close_sprint to close. Returns the updated sprint.",
    parameters: z.object({
      sprintId: z.number().int().positive().describe("Jira sprint id"),
      name: z.string().min(1).optional().describe("Sprint name"),
      goal: z.string().optional().describe("Sprint goal"),
      startDate: z.string().optional().describe("Sprint start date as accepted by Jira"),
      endDate: z.string().optional().describe("Sprint end date as accepted by Jira"),
      state: z.enum(["future", "active"]).optional().describe("Sprint state. Use jira_close_sprint to close a sprint."),
    }),
    execute: async (args) => {
      const input = {
        name: args.name,
        goal: args.goal,
        startDate: args.startDate,
        endDate: args.endDate,
        state: args.state as JiraSprintState | undefined,
      };
      if (Object.values(input).every((value) => value === undefined)) throw new Error("Provide at least one field to edit");

      const sprint = await (await getClient()).updateJiraSprint(args.sprintId, input);
      return JSON.stringify({ status: "updated", sprint }, null, 2);
    },
  });

  server.addTool({
    name: "jira_close_sprint",
    description: "Preview or close a Jira sprint. Can move specified issues first. Closing requires force true and confirm matching the sprint id.",
    parameters: z.object({
      sprintId: z.number().int().positive().describe("Jira sprint id"),
      issueKeys: z.array(z.string()).optional().describe("Issue keys to roll over before closing"),
      moveToSprintId: z.number().int().positive().optional().describe("Move issueKeys to this sprint before closing"),
      moveToBacklog: z.boolean().default(false).describe("Move issueKeys to the backlog before closing"),
      includePoints: z.boolean().default(false).describe("Include a committed/completed story point rollup, measured before any rollover move"),
      pointsField: z.string().optional().describe("Story point field id; defaults to ATLASSIAN_STORY_POINTS_FIELD or customfield_10105"),
      force: z.boolean().default(false).describe("Must be true to close"),
      confirm: z.string().optional().describe("Must match fetched sprint id when force is true"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const moveInput = buildMoveInput(args);
      await validateRolloverTarget(client, moveInput);
      const sprint = await client.getJiraSprint(args.sprintId);
      // Rolled up before any rollover move, so committed describes the sprint as committed rather
      // than the remainder left after unfinished work moves out.
      const points = await rollupPoints(client, sprint.id, args);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          wouldClose: { id: sprint.id, name: sprint.name, state: sprint.state },
          rollover: moveInput,
          batches: moveInput ? planBatches(moveInput.issueKeys) : 0,
          issueCount: moveInput?.issueKeys.length ?? 0,
          points,
          hint: `Call again with force true and confirm "${sprint.id}" to close this Jira sprint.`,
        }, null, 2);
      }

      if (args.confirm !== String(sprint.id)) {
        return JSON.stringify({
          status: "confirmation_required",
          sprint: { id: sprint.id, name: sprint.name, state: sprint.state },
          hint: `Call again with force true and confirm "${sprint.id}" to close this Jira sprint.`,
        }, null, 2);
      }

      let moveResult: JiraSprintIssueMoveResult | undefined;
      if (moveInput) {
        moveResult = await client.moveJiraSprintIssues(moveInput);
        if (moveResult.failed.length > 0) {
          return moveFailureResult({ sprint: { id: sprint.id, name: sprint.name, state: sprint.state } }, moveResult, moveInput.issueKeys.length);
        }
      }

      const closed = await client.updateJiraSprint(sprint.id, { state: "closed" });
      return JSON.stringify({
        status: "closed",
        sprint: closed,
        rollover: moveInput,
        batches: moveResult?.batches ?? 0,
        moved: moveResult?.moved ?? 0,
        failed: [],
        points,
      }, null, 2);
    },
  });

  server.addTool({
    name: "jira_delete_sprint",
    description:
      "Preview or permanently delete a Jira sprint. Jira moves the sprint's open issues to the backlog. Deletion requires force true and confirm matching the sprint id.",
    parameters: z.object({
      sprintId: z.number().int().positive().describe("Jira sprint id"),
      force: z.boolean().default(false).describe("Must be true to delete"),
      confirm: z.string().optional().describe("Must match fetched sprint id when force is true"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const sprint = await client.getJiraSprint(args.sprintId);
      const sprintLabel = { id: sprint.id, name: sprint.name, state: sprint.state };

      if (!args.force) {
        // Counted only for the preview, so the caller can see what Jira will move to the backlog.
        const { issues } = await client.listJiraSprintIssues(sprint.id, { fields: ["status"] });
        return JSON.stringify({
          status: "dry_run",
          wouldDelete: sprintLabel,
          issueCount: issues.length,
          hint: `Call again with force true and confirm "${sprint.id}" to permanently delete this Jira sprint. Its open issues move to the backlog.`,
        }, null, 2);
      }

      if (args.confirm !== String(sprint.id)) {
        return JSON.stringify({
          status: "confirmation_required",
          sprint: sprintLabel,
          hint: `Call again with force true and confirm "${sprint.id}" to permanently delete this Jira sprint.`,
        }, null, 2);
      }

      await client.deleteJiraSprint(sprint.id);
      return JSON.stringify({ status: "deleted", sprint: sprintLabel }, null, 2);
    },
  });

  server.addTool({
    name: "jira_rollover_sprint_issues",
    description: "Preview or move Jira issues from a source sprint to another sprint or the backlog. Requires force true and confirm matching the source sprint id.",
    parameters: z.object({
      sourceSprintId: z.number().int().positive().describe("Source Jira sprint id"),
      issueKeys: z.array(z.string()).min(1).describe("Issue keys to move"),
      moveToSprintId: z.number().int().positive().optional().describe("Move issues to this sprint"),
      moveToBacklog: z.boolean().default(false).describe("Move issues to the backlog"),
      force: z.boolean().default(false).describe("Must be true to move issues"),
      confirm: z.string().optional().describe("Must match fetched source sprint id when force is true"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const moveInput = buildMoveInput(args);
      if (!moveInput) throw new Error("Provide one rollover target: moveToSprintId or moveToBacklog");
      await validateRolloverTarget(client, moveInput);
      const sprint = await client.getJiraSprint(args.sourceSprintId);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          sourceSprint: { id: sprint.id, name: sprint.name, state: sprint.state },
          rollover: moveInput,
          batches: planBatches(moveInput.issueKeys),
          issueCount: moveInput.issueKeys.length,
          hint: `Call again with force true and confirm "${sprint.id}" to move these Jira issues.`,
        }, null, 2);
      }

      if (args.confirm !== String(sprint.id)) {
        return JSON.stringify({
          status: "confirmation_required",
          sprint: { id: sprint.id, name: sprint.name, state: sprint.state },
          hint: `Call again with force true and confirm "${sprint.id}" to move these Jira issues.`,
        }, null, 2);
      }

      const moveResult = await client.moveJiraSprintIssues(moveInput);
      if (moveResult.failed.length > 0) {
        return moveFailureResult({ sourceSprint: { id: sprint.id, name: sprint.name } }, moveResult, moveInput.issueKeys.length);
      }

      return JSON.stringify({
        status: "moved",
        sourceSprint: { id: sprint.id, name: sprint.name },
        rollover: moveInput,
        batches: moveResult.batches,
        moved: moveResult.moved,
        failed: [],
      }, null, 2);
    },
  });

  server.addTool({
    name: "jira_add_attachment",
    description:
      "Upload file attachments to one Jira issue. Use paths for files already on disk, or files for content you generate inline.",
    parameters: z.object({
      issueIdOrKey: z.string().describe("Jira issue key or id"),
      paths: z.array(z.string()).default([]).describe("Local file paths to upload"),
      files: z
        .array(
          z.object({
            filename: z.string().describe("Name to store the attachment under"),
            content: z.string().describe("File content, encoded per the encoding field"),
            encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of content"),
            contentType: z.string().optional().describe("MIME type; guessed from filename when omitted"),
          })
        )
        .default([])
        .describe("Inline files to upload"),
    }),
    execute: async (args) => {
      const fromPaths: JiraAttachmentUpload[] = await Promise.all(
        args.paths.map(async (path) => ({ filename: basename(path), data: await readFile(path) }))
      );
      const fromInline: JiraAttachmentUpload[] = args.files.map((file) => ({
        filename: file.filename,
        contentType: file.contentType,
        data: file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content,
      }));
      const uploads = [...fromPaths, ...fromInline];

      if (uploads.length === 0) {
        return JSON.stringify({
          status: "no_files",
          hint: "Provide at least one entry in paths or files.",
        }, null, 2);
      }

      const attachments = await (await getClient()).addJiraAttachments(args.issueIdOrKey, uploads);
      return JSON.stringify({
        status: "uploaded",
        issue: args.issueIdOrKey,
        attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, mimeType: a.mimeType })),
      }, null, 2);
    },
  });

  server.addTool({
    name: "confluence_get_page",
    description:
      "Read a Confluence page: id, title, space, status, version (pass it to confluence_edit_page as expectVersion), parent, url, and the body. Markdown is the default format. Content markdown cannot express shows as [[cf:kind ...]] placeholders and is counted in `lossy`. Bodies over 12,000 characters return the outline with section sizes instead; ask for `sections` or set `full`.",
    parameters: z.object({
      pageId: z.string().min(1).describe("Confluence page id"),
      format: z.enum(["markdown", "storage", "adf"]).default("markdown").describe("Body format"),
      outline: z.boolean().default(false).describe("Headings and section sizes only"),
      sections: z.array(z.string()).optional().describe('Sections to return, by heading, "Parent > Child" path, or path with " [n]"'),
      meta: z.boolean().default(false).describe("Metadata only, no body"),
      full: z.boolean().default(false).describe("Return the whole body even over the size guard"),
      draft: z.boolean().default(false).describe("Read the unpublished draft when one exists"),
    }),
    execute: async (args) => {
      const page = await (await getClient()).getConfluencePageContent(args.pageId, args);
      return JSON.stringify(page);
    },
  });

  server.addTool({
    name: "confluence_search",
    description:
      'Search Confluence with CQL, or with `text` (siteSearch) narrowed by `space` and `type` (default page). Returns id, title, space, type, modified (ISO date), and a 90-character excerpt per hit by default, plus `isLast` and `nextCursor` for the next page. `fields` picks from id, title, space, type, modified, excerpt, url, version, ancestors, status.',
    parameters: z.object({
      cql: z.string().optional().describe("CQL query"),
      text: z.string().optional().describe("Words to search for, instead of cql"),
      space: z.string().optional().describe("Space key to narrow text"),
      type: z.string().optional().describe("Content type to narrow text; default page"),
      limit: z.number().int().positive().default(10).describe("Results per page"),
      cursor: z.string().optional().describe("nextCursor from a previous page"),
      fields: z.array(z.enum(["id", "title", "space", "type", "modified", "excerpt", "url", "version", "ancestors", "status"])).optional().describe("Fields to return"),
      excerpt: z.enum(["none", "short", "full"]).default("short").describe("Excerpt length"),
    }),
    execute: async (args) => JSON.stringify(await (await getClient()).searchConfluence(args)),
  });

  server.addTool({
    name: "confluence_create_page",
    description:
      "Create a Confluence page under a parent (the space comes from the parent) or in a space. The body is markdown by default (headings, lists, task lists, tables, code, quotes, links, inline marks), or storage or ADF. A title already in the space fails with title_exists. Set dryRun to check the space, the parent's ancestor path, and the body size first. Returns id, title, version, status, and url; never the body.",
    parameters: z.object({
      title: z.string().min(1).describe("Page title"),
      parentId: z.string().optional().describe("Parent page id"),
      space: z.string().optional().describe("Space key or id, when there is no parent"),
      body: z.string().describe("Page body"),
      format: z.enum(["markdown", "storage", "adf"]).default("markdown").describe("Body format"),
      draft: z.boolean().default(false).describe("Create an unpublished draft"),
      labels: z.array(z.string()).optional().describe("Labels to add"),
      dryRun: z.boolean().default(false).describe("Resolve placement and body without creating"),
    }),
    execute: async (args) => {
      if ((args.parentId === undefined) === (args.space === undefined)) throw new Error("Pass exactly one of parentId or space");
      const result = await (await getClient()).createConfluencePage(
        { title: args.title, parentId: args.parentId, space: args.space, body: { value: args.body, format: args.format }, draft: args.draft, labels: args.labels },
        { dryRun: args.dryRun }
      );
      return JSON.stringify(result);
    },
  });

  server.addTool({
    name: "confluence_edit_page",
    description:
      "Edit a Confluence page. Targeted operations change only that part and leave macros and images elsewhere untouched: replaceSection (heading, path, or path [n]) with a body, append or prepend a body, findReplace (exact text; must match once unless all), or a title change. replaceBody replaces the whole page and requires expectVersion. A stale expectVersion fails with version_conflict; replacing content markdown cannot carry fails with lossy_replace unless allowLossy. Set dryRun to see sizes and match counts first. Returns id, title, new version, and url; never the body.",
    parameters: z.object({
      pageId: z.string().min(1).describe("Confluence page id"),
      operation: z.enum(["replaceSection", "append", "prepend", "findReplace", "replaceBody"]).optional().describe("Body operation; omit for a title-only change"),
      section: z.string().optional().describe("Section selector for replaceSection"),
      body: z.string().optional().describe("Body for replaceSection, append, prepend, or replaceBody"),
      format: z.enum(["markdown", "adf", "storage"]).default("markdown").describe("Body format; storage only for replaceBody"),
      find: z.string().optional().describe("Exact text for findReplace"),
      replace: z.string().optional().describe("Replacement text for findReplace"),
      all: z.boolean().default(false).describe("Replace every findReplace match"),
      title: z.string().optional().describe("New title"),
      expectVersion: z.number().int().positive().optional().describe("Version you read; required for replaceBody"),
      message: z.string().optional().describe("Version comment"),
      allowLossy: z.boolean().default(false).describe("Write even if markdown replaces content it cannot carry"),
      dryRun: z.boolean().default(false).describe("Report what would change without writing"),
    }),
    execute: async (args) => {
      const body = { value: args.body, format: args.format };
      const need = (value: string | undefined, name: string) => {
        if (value === undefined) throw new Error(`${args.operation} needs ${name}`);
        return value;
      };
      let operation: ConfluenceEditOperation | undefined;
      switch (args.operation) {
        case "replaceSection":
          need(args.body, "body");
          operation = { kind: "replaceSection", section: need(args.section, "section"), body };
          break;
        case "append":
        case "prepend":
          need(args.body, "body");
          operation = { kind: args.operation, body };
          break;
        case "findReplace":
          operation = { kind: "findReplace", find: need(args.find, "find"), replace: need(args.replace, "replace"), all: args.all };
          break;
        case "replaceBody":
          need(args.body, "body");
          operation = { kind: "replaceBody", body };
          break;
        case undefined:
          if (args.title === undefined) throw new Error("Provide an operation or a title");
      }
      const result = await (await getClient()).editConfluencePage(
        args.pageId,
        { operation, title: args.title },
        { dryRun: args.dryRun, expectVersion: args.expectVersion, allowLossy: args.allowLossy, message: args.message }
      );
      return JSON.stringify(result);
    },
  });

  server.addTool({
    name: "confluence_upload_attachment",
    description: "Upload one local file as an attachment to a Confluence page. Defaults to create-or-update for retry-safe uploads; set createOnly to true to fail on existing filenames. Returns attachment metadata only.",
    parameters: z.object({
      pageId: z.string().min(1).describe("Confluence page id"),
      filePath: z.string().min(1).describe("Local file path to upload"),
      filename: z.string().min(1).optional().describe("Attachment filename; defaults to the local basename"),
      comment: z.string().optional().describe("Attachment version comment"),
      mediaType: z.string().min(1).optional().describe("Media type for the uploaded file"),
      notify: z.boolean().default(false).describe("Notify watchers by not marking the upload as a minor edit"),
      createOnly: z.boolean().default(false).describe("Fail if an attachment with the same filename already exists"),
    }),
    execute: async (args) => {
      const pageId = requireNonEmpty(args.pageId, "pageId");
      const filePath = requireNonEmpty(args.filePath, "filePath");
      const filename = requireNonEmpty(args.filename ?? basename(filePath), "filename");
      const file = Bun.file(filePath, args.mediaType === undefined ? undefined : { type: args.mediaType });
      if (!(await file.exists())) throw new Error(`filePath does not exist or is not readable: ${filePath}`);
      const bytes = await file.bytes().catch(() => null);
      if (bytes === null) throw new Error(`filePath does not exist or is not readable: ${filePath}`);

      const result = await (await getClient()).uploadConfluenceAttachment(pageId, {
        file: new Blob([bytes], { type: args.mediaType ?? file.type }),
        filename,
        comment: args.comment,
        minorEdit: !args.notify,
        createOnly: args.createOnly,
      });

      return JSON.stringify({
        status: "uploaded",
        pageId,
        attachments: summarizeAttachments(result),
      }, null, 2);
    },
  });

  server.addTool({
    name: "confluence_delete_page",
    description: "Preview, trash, or purge one Confluence page. Deletion requires force true and confirm matching the page id.",
    parameters: z.object({
      pageId: z.string().describe("Confluence page id"),
      purge: z.boolean().default(false).describe("Permanently purge an already-trashed page"),
      force: z.boolean().default(false).describe("Must be true to delete"),
      confirm: z.string().optional().describe("Must match fetched page id when force is true"),
    }),
    execute: async (args) => {
      const client = await getClient();
      const page = await client.getConfluencePage(args.pageId);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          wouldDelete: { id: page.id, title: page.title, status: page.status },
          purge: args.purge,
          hint: `Call again with force true and confirm "${page.id}" to ${args.purge ? "purge" : "trash"} this Confluence page.`,
        }, null, 2);
      }

      if (args.confirm !== page.id) {
        return JSON.stringify({
          status: "confirmation_required",
          page: { id: page.id, title: page.title, status: page.status },
          hint: `Call again with force true and confirm "${page.id}" to ${args.purge ? "purge" : "trash"} this Confluence page.`,
        }, null, 2);
      }

      await client.deleteConfluencePage(args.pageId, { purge: args.purge });
      return JSON.stringify({ status: args.purge ? "purged" : "trashed", page: { id: page.id, title: page.title } }, null, 2);
    },
  });
}
