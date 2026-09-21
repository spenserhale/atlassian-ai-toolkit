# Jira Sprint Points Rollup Design

## Problem

After a sprint closes, reporting the points booked for it means fetching every issue and summing the
story-point custom field by hand. `sprint close` returns `{status, sprint, rollover, batches, moved,
failed}` and `sprint get` returns the raw Agile sprint object; neither carries committed or
completed points, so the last question of every sprint close is answered outside the toolkit.

## Proposal

Add `getJiraSprintPoints(sprintId, opts)` to the SDK. It lists the sprint's issues with only the
story-point field and `status` requested, then sums:

- `committed` — points across every issue in the sprint.
- `completed` — points on issues whose `status.statusCategory.key` is `done`.
- `issueCount` and `unestimated` — so a small `completed` caused by missing estimates is visible
  rather than silent.

Sums are rounded to two decimals because Jira allows fractional points and repeated float addition
drifts.

The story-point field id varies by site, so it resolves in order: an explicit `pointsField` option,
the `ATLASSIAN_STORY_POINTS_FIELD` environment variable, then the `customfield_10105` default.

Wire into `sprint get` and `sprint close` behind a `--points` flag with an optional `--points-field`
override, and into the MCP tools `jira_get_sprint` and `jira_close_sprint` as `includePoints` /
`pointsField`. For `sprint close`, points are computed before the rollover moves run, so the numbers
describe the sprint as it was committed rather than what happened to be left in it after unfinished
work moved out. The dry-run preview reports the same rollup, so the velocity is visible before the
close is confirmed.

## Endpoint

No new endpoint. Reuses `GET /rest/agile/1.0/sprint/<id>/issue` with
`fields=<pointsField>,status`, already auto-paginated by `listJiraSprintIssues`.

## Safety

Read-only. The flag is opt-in rather than always-on because the rollup costs one paginated pass over
the sprint, and `sprint get` is otherwise a single cheap request.

## Testing

SDK tests stub `globalThis.fetch` and assert the requested `fields` query, the committed/completed
split by status category, the unestimated count, and the field-id resolution order. CLI and MCP
remain covered by `tsc` per repo policy.
