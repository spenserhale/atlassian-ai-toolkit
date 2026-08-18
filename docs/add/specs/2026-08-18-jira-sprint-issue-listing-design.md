# Jira Sprint Issue Listing Design

## Problem

`sprint get` returns sprint metadata only. Rollover workflows need the issue keys in a sprint (often 50+ issues, beyond the Agile API's default page size of 50), and previously the only way to get them was `moveJiraSprintIssues` with a hand-written key list.

## Proposal

Add `listJiraSprintIssues(sprintId, opts)` to the SDK using `GET /rest/agile/1.0/sprint/{sprintId}/issue`. The method auto-paginates with `startAt`/`maxResults` until `total` is reached or `isLast` is true, and returns `{ total, issues }`. Optional `opts.maxResults` sets the page size and `opts.fields` limits returned fields via the `fields` query parameter.

Wire the operation into the CLI as `atlassian jira sprint issues <sprint-id>` (read-only, `--json` supported) and into MCP as `jira_list_sprint_issues`.

## Endpoints

```text
GET /rest/agile/1.0/sprint/{sprintId}/issue?startAt=0&maxResults=50
```

The Agile API is used for consistency with the other sprint operations; it returns `{ startAt, maxResults, total, isLast, issues }`.

## Safety

Read-only. No preview/confirm gates required. Issue deletion and sprint mutations keep their existing safeguards.

## Testing

SDK tests stub `globalThis.fetch` and assert exact URLs, method, single-page behavior, multi-page aggregation, and `fields`/`maxResults` passthrough. CLI and MCP remain covered by `tsc` per repo policy.
