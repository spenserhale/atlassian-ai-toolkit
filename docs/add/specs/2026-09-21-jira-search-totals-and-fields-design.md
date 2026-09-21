# Jira Search Totals And Field Selection Design

## Problem

`jira search --json` returns a bare `{"issues": [...]}`. With `--limit` capping the walk there is no
way to tell a complete result set from a truncated one, so an audit query that reports zero
remaining gaps has to be trusted on faith. `sprint list` already returns `total` / `isLast` /
`startAt`; search does not.

Search also returns every custom field on the screen — a few hundred mostly-null keys per issue — so
a sprint-sized query is megabytes and the workflow has to redirect it to a file rather than read it.
The SDK accepts a `fields` option and the MCP tool exposes it, but the CLI does not, and neither
`sprint issues` surface does.

## Proposal

Return pagination metadata from `searchJiraIssues` alongside the issues:

- `isLast` — true when the walk exhausted the result set, false when it stopped at `limit`.
  Truncation becomes detectable instead of inferred.
- `total` — the exact count when `isLast`, since the walk has then seen every issue. When truncated,
  `POST /rest/api/3/search/approximate-count` supplies the count in one extra request. The enhanced
  search endpoint uses token pagination and does not return a total of its own, so this is the only
  source; it is approximate by name and is documented as such.
- `startAt` — always 0, and `maxResults` — the page size, both for shape parity with `sprint list`.

Add `--fields key,summary,status,customfield_10105` to `jira search` and `jira sprint issues` in the
CLI, and a `fields` parameter to the `jira_list_sprint_issues` MCP tool, so the response can be
trimmed to what the caller actually reads. `jira_search_issues` already takes `fields`.

## Endpoint

```text
POST /rest/api/3/search/approximate-count
{ "jql": "..." }
```

Response: `{ "count": 231 }`. Called only when the result set was truncated, so an untruncated search
still costs exactly the requests it costs today.

## Safety

Read-only. No preview/confirm gates required.

## Testing

SDK tests stub `globalThis.fetch` and assert `isLast`/`total` for an exhausted walk, the extra
count request and `isLast: false` for a limit-truncated walk, and `fields` passthrough. CLI and MCP
remain covered by `tsc` per repo policy.
