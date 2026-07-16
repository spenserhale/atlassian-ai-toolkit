# Jira Sprint Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use add-subagent-driven-development (recommended) or add-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Jira sprint lifecycle SDK methods, CLI subcommands, and MCP tools for listing, creating, editing, closing, and rolling over sprints.

**Architecture:** Keep Atlassian API calls centralized in `packages/sdk`. Add a `jira sprint` CLI route that delegates to SDK methods and keeps consequential sprint state/issue moves preview-first. Add MCP tools with the same safety semantics as the CLI.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Jira Software Cloud Agile REST API.

---

## Files

- Modify `packages/sdk/src/types.ts` with sprint schemas and input types.
- Modify `packages/sdk/src/index.ts` to export sprint types and schemas.
- Modify `packages/sdk/src/client.ts` with Agile sprint methods.
- Modify `packages/sdk/tests/client.test.ts` with fetch-based SDK request tests.
- Create `packages/cli/src/commands/jira-sprint.ts` for sprint subcommands.
- Modify `packages/cli/src/app.ts` to mount `jira sprint`.
- Modify `packages/mcp/src/tools/resources.ts` to add sprint lifecycle tools.

## Task 1: SDK Sprint Types And Requests

**Files:**
- Modify: `packages/sdk/tests/client.test.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/client.ts`

- [ ] **Step 1: Write failing SDK tests**

Add tests that stub `globalThis.fetch` and assert exact Jira Agile URLs and JSON bodies for `createJiraSprint`, `updateJiraSprint`, `listJiraSprints`, `getJiraSprint`, and `moveJiraSprintIssues`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/tests/client.test.ts`

Expected: FAIL because sprint methods do not exist.

- [ ] **Step 3: Add sprint schemas and exports**

Add `JiraSprintSchema`, `JiraSprintListSchema`, `JiraSprintStateSchema`, input types for create/update/list/move, and export them from `packages/sdk/src/index.ts`.

- [ ] **Step 4: Add SDK request methods**

Implement methods using these endpoints:

```text
GET  /rest/agile/1.0/sprint/{sprintId}
GET  /rest/agile/1.0/board/{boardId}/sprint?state=active
POST /rest/agile/1.0/sprint
POST /rest/agile/1.0/sprint/{sprintId}
POST /rest/agile/1.0/sprint/{targetSprintId}/issue
POST /rest/agile/1.0/backlog/issue
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/sdk/tests/client.test.ts`

Expected: PASS.

## Task 2: CLI Sprint Route

**Files:**
- Create: `packages/cli/src/commands/jira-sprint.ts`
- Modify: `packages/cli/src/app.ts`

- [ ] **Step 1: Add route implementation**

Create `jiraSprintRoutes` with `get`, `list`, `create`, `edit`, `close`, and `rollover` commands. Use `--json` output where existing commands do. Use comma-separated `--issues KEY-1,KEY-2` for rollover to avoid relying on repeated flag support.

- [ ] **Step 2: Add safety gates**

Make `close` and `rollover` return `status: dry_run` unless `--force` is supplied. If `--force` is supplied, require `--confirm <sprint-id>` before calling the SDK mutation methods.

- [ ] **Step 3: Mount route**

Add `sprint: jiraSprintRoutes` under `jira` in `packages/cli/src/app.ts`.

- [ ] **Step 4: Type-check CLI**

Run: `bun run --filter '@atlassian-ai-toolkit/cli' lint`

Expected: PASS.

## Task 3: MCP Sprint Tools

**Files:**
- Modify: `packages/mcp/src/tools/resources.ts`

- [ ] **Step 1: Add read and mutation tools**

Add `jira_get_sprint`, `jira_list_sprints`, `jira_create_sprint`, `jira_edit_sprint`, `jira_close_sprint`, and `jira_rollover_sprint_issues`.

- [ ] **Step 2: Add safety gates**

Make `jira_close_sprint` and `jira_rollover_sprint_issues` preview unless `force: true` and matching `confirm` are supplied.

- [ ] **Step 3: Type-check MCP**

Run: `bun run --filter '@atlassian-ai-toolkit/mcp' lint`

Expected: PASS.

## Task 4: Verification

**Files:**
- No code files unless verification exposes issues.

- [ ] **Step 1: Run full lint**

Run: `bun run lint`

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run: `bun test`

Expected: PASS.

- [ ] **Step 3: Run CLI help smoke test**

Run: `bun run dev:cli -- jira sprint --help`

Expected: help lists `get`, `list`, `create`, `edit`, `close`, and `rollover`.

## Assumptions & Decisions

- Use Jira Agile `/rest/agile/1.0` endpoints for sprint operations.
- Keep rollover explicit via `--issues` because automated selection of incomplete work is outside this scope.
- Keep `close` and `rollover` preview-first because they change workflow state and issue assignment.
- Use comma-separated `--issues` instead of repeated `--issue` to avoid depending on unverified Stricli repeated flag behavior.
- Verify CLI and MCP through TypeScript until this project adds a command execution test harness.
- Use Jira's partial sprint update endpoint for edits so omitted sprint fields are not cleared.
- Keep sprint closing out of generic edit commands/tools so close confirmation safeguards cannot be bypassed.
