# Jira Search Totals And Field Selection Implementation Plan

**Goal:** Make truncation detectable on `jira search` and let callers trim the fields returned by
search and sprint issue listing.

**Architecture:** Extend the existing `searchJiraIssues` walk to report whether it exhausted the
result set, and fall back to the approximate-count endpoint for a total only when it did not. Add
`--fields` plumbing to the CLI and MCP surfaces that lack it.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Jira Cloud platform REST API v3.

---

## Files

- Modify `packages/sdk/src/types.ts` with the approximate-count schema and the widened result type.
- Modify `packages/sdk/src/client.ts` with `countJiraIssues` and the reworked search walk.
- Modify `packages/sdk/src/index.ts` to export the new schema.
- Modify `packages/sdk/tests/client.test.ts` with truncation and total tests.
- Modify `packages/cli/src/commands/jira-search.ts` for `--fields` and the new summary line.
- Modify `packages/cli/src/commands/jira-sprint.ts` for `sprint issues --fields`.
- Modify `packages/mcp/src/tools/resources.ts` for `jira_list_sprint_issues` fields.
- Modify `packages/mcp/README.md` and the root `README.md`.

## Task 1: SDK

- [x] Track whether the page walk exhausted the result set or stopped at `limit`.
- [x] Return `{ issues, total, isLast, startAt, maxResults }`.
- [x] Add `countJiraIssues` over `POST /rest/api/3/search/approximate-count`, called only when the
      result was truncated.

## Task 2: SDK Tests

- [x] Exhausted walk asserts `isLast: true`, an exact `total`, and no count request.
- [x] Truncated walk asserts `isLast: false`, the count request, and the approximate `total`.
- [x] `fields` passthrough asserted on search and sprint issue listing.

## Task 3: CLI

- [x] `jira search --fields a,b,c`, and a text summary line reporting `total` and truncation.
- [x] `jira sprint issues --fields a,b,c`.

## Task 4: MCP

- [x] `jira_list_sprint_issues` takes `fields`; descriptions mention the new result metadata.

## Task 5: Verification

- [x] `bun test` passes.
- [x] `bun run lint` passes.
- [x] `bun run dev:cli -- jira search --help` prints the new flag.

## Assumptions & Decisions

- The enhanced search endpoint has no `total`, so an exact count is only free when the walk saw the
  whole result set; otherwise the approximate-count endpoint is the documented source and the value
  is approximate.
- `startAt` is always 0 because the endpoint pages by token; it is reported only so the result shape
  matches `sprint list`.
