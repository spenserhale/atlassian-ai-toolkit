# Jira Sprint Issue Listing Implementation Plan

**Goal:** Add an SDK method that lists every issue in a sprint with auto-pagination, wired into the CLI and MCP.

**Architecture:** Keep the Atlassian Agile API call in `packages/sdk`. Add a read-only `issues` subcommand to the `jira sprint` CLI route and a `jira_list_sprint_issues` MCP tool. No confirmation gates because the operation is read-only.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Jira Software Cloud Agile REST API.

---

## Files

- Modify `packages/sdk/src/types.ts` with the sprint issue page schema and list types.
- Modify `packages/sdk/src/index.ts` to export the new schemas and types.
- Modify `packages/sdk/src/client.ts` with the paginated `listJiraSprintIssues` method.
- Modify `packages/sdk/tests/client.test.ts` with fetch-based request tests.
- Modify `packages/cli/src/commands/jira-sprint.ts` to add the `issues` subcommand.
- Modify `packages/mcp/src/tools/resources.ts` to add `jira_list_sprint_issues`.
- Modify `packages/mcp/README.md` tool table.

## Task 1: SDK Types And Paginated Method

- [x] Add `JiraSprintIssuePageSchema` (agile envelope: `startAt`, `maxResults`, `total`, `isLast`, `issues`), `JiraSprintIssueList`, and `JiraSprintIssueListOptions` (`maxResults`, `fields`).
- [x] Implement `listJiraSprintIssues` looping `GET /rest/agile/1.0/sprint/{sprintId}/issue` with `startAt` until `total`/`isLast` indicates completion; return `{ total, issues }`.
- [x] Export new schemas and types from `packages/sdk/src/index.ts`.

## Task 2: SDK Tests

- [x] Single-page listing asserts URL `.../sprint/42/issue?startAt=0&maxResults=50` and parsed issues.
- [x] Multi-page test asserts two requests (`startAt=0`, `startAt=2`) and aggregated keys.
- [x] Options test asserts `maxResults=100` and `fields=summary%2Cstatus` passthrough.

## Task 3: CLI

- [x] Add `issues` command: positional sprint ID, `--json` flag, text output `issues[N]:` plus `- KEY: summary (status)` lines.
- [x] Register `issues` in `jiraSprintRoutes`.

## Task 4: MCP

- [x] Add `jira_list_sprint_issues` tool with `sprintId: z.number().int().positive()`, returning the SDK result as JSON.

## Task 5: Verification

- [x] `bun test` passes.
- [x] `bun run lint` passes.
- [x] `bun run dev:cli -- jira sprint --help` lists `issues`.

## Assumptions & Decisions

- Auto-paginate in the SDK because rollover needs complete key lists (~80 issues) and the Agile API default page size is 50.
- Use the Agile endpoint (not `POST /rest/api/3/search/jql`) for consistency with the other sprint operations.
- Default page size of 50 matches the API default; callers may raise it via options.
- Loop terminates on `isLast`, an empty page, or reaching `total` so a misbehaving server cannot loop forever.
