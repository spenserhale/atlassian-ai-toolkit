# Jira JQL Search Implementation Plan

**Goal:** Add an SDK method that runs a JQL search with token-based auto-pagination, wired into the CLI and MCP.

**Architecture:** Keep the search call in `packages/sdk` using the enhanced search endpoint. Add a read-only `jira search` CLI command and a `jira_search_issues` MCP tool. No confirmation gates because the operation is read-only.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Jira Cloud platform REST API v3.

---

## Files

- Modify `packages/sdk/src/types.ts` with the search page schema, options, and result types.
- Modify `packages/sdk/src/index.ts` to export the new schema and types.
- Modify `packages/sdk/src/client.ts` with the paginated `searchJiraIssues` method.
- Modify `packages/sdk/tests/client.test.ts` with fetch-based request tests.
- Create `packages/cli/src/commands/jira-search.ts`.
- Modify `packages/cli/src/app.ts` to mount `jira search`.
- Modify `packages/mcp/src/tools/resources.ts` to add `jira_search_issues`.
- Modify `packages/mcp/README.md` tool table.

## Task 1: SDK Types And Paginated Method

- [x] Add `JiraSearchPageSchema` (`nextPageToken`, `isLast`, `issues`), `JiraSearchOptions` (`maxResults`, `fields`, `limit`), `JiraSearchResult`.
- [x] Implement `searchJiraIssues` looping `POST /rest/api/3/search/jql` with `nextPageToken` until absent, `isLast`, or an empty page; apply `limit` truncation.
- [x] Export new schema and types from `packages/sdk/src/index.ts`.

## Task 2: SDK Tests

- [x] Single-page search asserts URL, POST method, and body `{ jql, maxResults: 100, fields: ["*navigable"] }`.
- [x] Multi-page test asserts the second request carries `nextPageToken` and issues aggregate.
- [x] Options test asserts `limit` truncation and `fields` passthrough.

## Task 3: CLI

- [x] Create `jira search` command with required `--jql`, optional `--limit`, `--json`; text output `issues[N]:` plus `- KEY: summary (status)` lines.
- [x] Mount `search` in the `jira` route map in `packages/cli/src/app.ts`.

## Task 4: MCP

- [x] Add `jira_search_issues` tool with `jql`, optional `limit` and `fields`, returning the SDK result as JSON.

## Task 5: Verification

- [x] `bun test` passes.
- [x] `bun run lint` passes.
- [x] `bun run dev:cli -- jira search --help` prints usage.

## Assumptions & Decisions

- Use `POST /rest/api/3/search/jql` because the legacy `/rest/api/3/search` endpoints are deprecated and being removed; the new endpoint only supports token pagination, so `total` is unavailable and the result is `{ issues }`.
- Default `fields` to `["*navigable"]` so summary/status are included without requesting all fields.
- Default page size of 100; `limit` caps total fetches so broad queries stay cheap.
- Loop terminates on a missing `nextPageToken`, `isLast`, or an empty page so a misbehaving server cannot loop forever.
