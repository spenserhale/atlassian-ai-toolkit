# Jira Sprint Lifecycle Commands Design

## Goal

Add Jira sprint lifecycle operations to the toolkit so agents and humans can manage active and future sprints without leaving the CLI or MCP server. The supported workflows are closing the current sprint, moving unfinished issues into another sprint or the backlog, creating future sprints, and editing the active sprint.

## Scope

The SDK remains the source of truth for Atlassian REST calls. The CLI and MCP server expose thin wrappers over SDK methods. This design covers Jira Agile sprint operations only; it does not add board discovery, issue ranking, sprint report generation, or interactive prompts.

## API Surface

SDK methods:

- `getJiraSprint(sprintId)` reads a sprint.
- `listJiraSprints(boardId, options)` lists board sprints with optional state filtering.
- `createJiraSprint(input)` creates a future sprint for a board.
- `updateJiraSprint(sprintId, input)` edits sprint metadata or state.
- `moveJiraSprintIssues(input)` moves issues to another sprint or to the backlog.

CLI commands under `atlassian jira sprint`:

- `get <sprint-id>` returns sprint details.
- `list --board <board-id> [--state active|future|closed]` lists sprints for a board.
- `create --board <board-id> --name <name> [--goal ...] [--start-date ...] [--end-date ...]` creates a future sprint.
- `edit <sprint-id> [--name ...] [--goal ...] [--start-date ...] [--end-date ...] [--state future|active]` updates the active or future sprint.
- `close <sprint-id> [--move-to-sprint <id> | --move-to-backlog] [--issues KEY-1,KEY-2] [--dry-run] [--force --confirm <sprint-id>]` previews by default, and closes only with explicit confirmation.
- `rollover <sprint-id> (--move-to-sprint <id> | --move-to-backlog) --issues KEY-1,KEY-2 [--dry-run] [--force --confirm <sprint-id>]` previews by default, and moves only with explicit confirmation.

MCP tools mirror the lifecycle jobs with intent-shaped names: `jira_get_sprint`, `jira_list_sprints`, `jira_create_sprint`, `jira_edit_sprint`, `jira_close_sprint`, and `jira_rollover_sprint_issues`.

## Data Flow

All sprint operations use Jira Software Cloud Agile endpoints under `/rest/agile/1.0`. Create uses Jira's sprint create payload and edit uses Jira's partial sprint update endpoint. Closing a sprint is a confirmed sprint state update to `closed`; rollover is an issue move to another sprint or backlog. The close command can optionally run rollover first, then close, which matches how agents often describe the task as one lifecycle action.

## Safety

Creating and editing sprints are normal mutations and return the changed sprint. Closing a sprint and moving issues are consequential workflow changes, so CLI and MCP tools preview by default. Execution requires `--force --confirm <sprint-id>` in the CLI or `force: true` plus matching `confirm` in MCP.

The CLI remains non-interactive. It prints compact text by default and JSON when `--json` is supplied, following existing command conventions.

## Errors

The SDK reuses the existing Atlassian HTTP error mapping. CLI commands validate mutually exclusive rollover targets before calling the SDK. Commands that need issue keys require a comma-separated `--issues` value so the tool does not guess which incomplete issues to move.

## Testing

Tests should cover SDK URL, method, query, and body behavior by replacing `globalThis.fetch`. CLI and MCP type coverage is verified through `tsc` until the project has a CLI execution test harness.

## Assumptions & Decisions

- Use Jira Agile `/rest/agile/1.0` because sprint and board operations are exposed by Jira Software Cloud Agile APIs, not the core `/rest/api/3` issue API.
- Require explicit issue keys for rollover because Jira does not expose a single generic "move all incomplete issues from sprint" endpoint; selecting incomplete work should stay with the caller or a future report-driven feature.
- Let `close` optionally perform rollover first because the user asked for closing the current sprint and rolling over items as sprint lifecycle tasks, and agents benefit from one safe workflow command.
- Keep `close` and `rollover` preview-by-default even though they are not deletes because they alter team workflow state and issue sprint assignment.
- Use comma-separated `--issues` instead of repeated `--issue` to avoid depending on unverified Stricli repeated flag behavior.
- Do not allow `edit` to set `state=closed`; closing must go through the dedicated close command/tool so confirmation safeguards cannot be bypassed.
- Do not expose manual `completeDate`; Jira manages sprint completion timestamps when the sprint state changes to closed.
- Do not add board discovery in this change because the requested lifecycle tasks can be satisfied with board and sprint IDs, and discovery can be added later as a separate read-only feature.
- Add MCP tools for every SDK operation because the repo's done criteria require CLI and MCP wiring unless there is a stated reason not to.
