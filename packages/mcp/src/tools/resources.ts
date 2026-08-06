import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { AtlassianClient, resolveConfig } from "@atlassian-ai-toolkit/sdk";
import type { JiraAttachmentUpload, JiraSprintState, MoveJiraSprintIssuesInput } from "@atlassian-ai-toolkit/sdk";

function getClient(): AtlassianClient {
  const config = resolveConfig();
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

export function registerResourceTools(server: FastMCP) {
  server.addTool({
    name: "jira_get_issue",
    description: "Get one Jira issue by key or id.",
    parameters: z.object({
      issueIdOrKey: z.string().describe("Jira issue key or id"),
    }),
    execute: async (args) => {
      const issue = await getClient().getJiraIssue(args.issueIdOrKey);
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
      const client = getClient();
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
    name: "jira_get_sprint",
    description: "Get one Jira sprint by id. Use this before editing or closing a sprint when you need the current state.",
    parameters: z.object({
      sprintId: z.number().int().positive().describe("Jira sprint id"),
    }),
    execute: async (args) => {
      const sprint = await getClient().getJiraSprint(args.sprintId);
      return JSON.stringify(sprint, null, 2);
    },
  });

  server.addTool({
    name: "jira_list_sprints",
    description: "List Jira sprints for a board, optionally filtered by state. Use to find active or future sprint ids.",
    parameters: z.object({
      boardId: z.number().int().positive().describe("Jira board id"),
      state: sprintStateSchema.optional().describe("Optional sprint state filter"),
    }),
    execute: async (args) => {
      const sprints = await getClient().listJiraSprints(args.boardId, {
        state: args.state,
      });
      return JSON.stringify(sprints, null, 2);
    },
  });

  server.addTool({
    name: "jira_create_sprint",
    description: "Create a future Jira sprint on a board. Returns the created sprint; no confirmation is required.",
    parameters: z.object({
      originBoardId: z.number().int().positive().describe("Board where the sprint is created"),
      name: z.string().min(1).describe("Sprint name"),
      goal: z.string().optional().describe("Sprint goal"),
      startDate: z.string().optional().describe("Sprint start date as accepted by Jira"),
      endDate: z.string().optional().describe("Sprint end date as accepted by Jira"),
    }),
    execute: async (args) => {
      const sprint = await getClient().createJiraSprint(args);
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

      const sprint = await getClient().updateJiraSprint(args.sprintId, input);
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
      force: z.boolean().default(false).describe("Must be true to close"),
      confirm: z.string().optional().describe("Must match fetched sprint id when force is true"),
    }),
    execute: async (args) => {
      const client = getClient();
      const moveInput = buildMoveInput(args);
      const sprint = await client.getJiraSprint(args.sprintId);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          wouldClose: { id: sprint.id, name: sprint.name, state: sprint.state },
          rollover: moveInput,
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

      if (moveInput) await client.moveJiraSprintIssues(moveInput);
      const closed = await client.updateJiraSprint(sprint.id, { state: "closed" });
      return JSON.stringify({ status: "closed", sprint: closed, rollover: moveInput }, null, 2);
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
      const client = getClient();
      const moveInput = buildMoveInput(args);
      if (!moveInput) throw new Error("Provide one rollover target: moveToSprintId or moveToBacklog");
      const sprint = await client.getJiraSprint(args.sourceSprintId);

      if (!args.force) {
        return JSON.stringify({
          status: "dry_run",
          sourceSprint: { id: sprint.id, name: sprint.name, state: sprint.state },
          rollover: moveInput,
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

      await client.moveJiraSprintIssues(moveInput);
      return JSON.stringify({ status: "moved", sourceSprint: { id: sprint.id, name: sprint.name }, rollover: moveInput }, null, 2);
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

      const attachments = await getClient().addJiraAttachments(args.issueIdOrKey, uploads);
      return JSON.stringify({
        status: "uploaded",
        issue: args.issueIdOrKey,
        attachments: attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size, mimeType: a.mimeType })),
      }, null, 2);
    },
  });

  server.addTool({
    name: "confluence_get_page",
    description: "Get one Confluence page by id.",
    parameters: z.object({
      pageId: z.string().describe("Confluence page id"),
    }),
    execute: async (args) => {
      const page = await getClient().getConfluencePage(args.pageId);
      return JSON.stringify(page, null, 2);
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

      const result = await getClient().uploadConfluenceAttachment(pageId, {
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
      const client = getClient();
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
