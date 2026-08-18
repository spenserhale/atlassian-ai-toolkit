# Jira JQL Search Design

## Problem

The toolkit can fetch a single issue and list a sprint's issues, but cannot answer arbitrary queries like "open bugs in this sprint" or "my unresolved work". Rollover workflows also need flexible selection (e.g. `sprint = 42 AND status != Done`) rather than whole-sprint listings only.

## Proposal

Add `searchJiraIssues(jql, opts)` to the SDK using `POST /rest/api/3/search/jql` (the enhanced search endpoint; the legacy `POST /rest/api/3/search` is deprecated and being removed). The method auto-paginates via `nextPageToken` and returns `{ issues }`. Options: `maxResults` (page size, default 100), `fields` (defaults to `["*navigable"]`), and `limit` (stop after N issues, useful for broad queries).

Wire into the CLI as `atlassian jira search --jql "..."` (read-only, `--limit` and `--json` flags) and MCP as `jira_search_issues` with `jql`, optional `limit`, and optional `fields`.

## Endpoint

```text
POST /rest/api/3/search/jql
{ "jql": "...", "maxResults": 100, "fields": ["*navigable"], "nextPageToken": "..." }
```

Response: `{ issues: [...], nextPageToken?: string, isLast?: boolean }`. Token pagination cannot skip items due to concurrent updates, unlike the retired `startAt` pagination.

## Safety

Read-only. No preview/confirm gates required.

## Testing

SDK tests stub `globalThis.fetch` and assert the endpoint, method, body (including `nextPageToken` on follow-up requests), aggregation across pages, and `limit`/`fields` passthrough. CLI and MCP remain covered by `tsc` per repo policy.
