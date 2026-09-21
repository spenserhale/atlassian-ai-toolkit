# Jira Issue Field Edit Design

## Problem

The toolkit can read issues (`jira get`, `jira search`, `jira sprint issues`) but cannot write a
field on one. A sprint-close audit can therefore enumerate issues missing Task Category, Request
Category, or Story Points and then has nowhere to go: the fix has to leave the toolkit for the Rovo
MCP or a hand-rolled `PUT /rest/api/3/issue/<key>`. Field hygiene is the point of the audit, so the
gap forces every run to abandon the CLI halfway through.

Writing fields is also more than a passthrough. Jira's edit payload shape depends on the field
schema: a single-select wants `{"value": "Support"}`, a number wants a bare `2`, labels want an
array of strings. A caller should not have to know which, and a caller that guesses wrong gets a
400 that names no useful recovery.

## Proposal

Add a field-edit path to the SDK built on the issue's own edit metadata.

- `getJiraIssueEditMeta(issueIdOrKey)` — `GET /rest/api/3/issue/<key>/editmeta`. Its `fields` map is
  exactly the set of fields settable on that issue, with each field's `schema` and `allowedValues`.
- `planJiraIssueFieldEdits(meta, edits)` — a pure function that resolves each requested field to its
  id (accepting either `customfield_13841` or the display name `Task Category`) and coerces the
  value to the shape the field's schema requires. Pure so it is unit-testable without HTTP.
- `editJiraIssue(issueIdOrKey, edits, opts)` — plan, then `PUT /rest/api/3/issue/<key>` with the
  resolved body. `opts.dryRun` returns the plan without sending.
- `editJiraIssues(batch, opts)` — the same per key over a batch, collecting per-key results and
  continuing past failures instead of aborting the run.

Coercion is driven by `schema.type` / `schema.items`, never by guessing from the input string:
`number` parses to a number, `option` becomes `{value}`, `array` of `option` becomes `[{value}]`,
`array` of `string` (labels) becomes a string array, `user` becomes `{accountId}`, name-keyed types
(`priority`, `version`, `component`, …) become `{name}`. Values already given as objects or arrays
pass through untouched, and a `json:` prefix is an explicit escape hatch for shapes the table does
not cover. When a field publishes `allowedValues`, the input is matched case-insensitively against
them and rewritten to the canonical casing; a miss fails before the request with the allowed list in
the error.

Errors carry recovery data rather than a bare 400. An unknown or unsettable field fails with
`field_not_settable` and the issue's `settableFields` in the error details, because Jira rejects the
whole call when one field is unsettable on that issue type (Story Points is absent from Sub-task,
Epic, and `Jira Task` screens) and the useful recovery is knowing which field to drop.

CLI:

```text
atlassian jira edit <KEY> --field <id|name>=<value> [--field ...] [--dry-run] [--json]
atlassian jira edit --from-file edits.json [--dry-run] [--json]
```

`--from-file` takes `[{"key":"DMP-2431","fields":{...}}]` so a batch of audit corrections is one
reviewable artifact and one command. It reports per-key results and exits non-zero if any key
failed, after attempting them all.

MCP: `jira_edit_issue` with `issueIdOrKey` + `fields`, or `edits` for the batch form, plus `dryRun`.

## Safety

Editing a field is not destructive: the previous value is in the issue history and Jira's own UI
requires no confirmation. So no `--force --confirm` gate, matching `jira sprint create` and
`jira sprint edit`. `--dry-run` prints the resolved JSON body without sending, matching the
`sprint close` / `sprint rollover` preview convention. Because the plan is computed from `editmeta`
before any write, a dry run is a real validation of the payload, not an echo of the input.

## Testing

SDK tests stub `globalThis.fetch` and assert the editmeta fetch, the `PUT` body per field type, the
batch continuing past a failing key, and dry-run sending no `PUT`. The coercion table and field-name
resolution are tested directly against fixture metadata. CLI and MCP remain covered by `tsc` per
repo policy.
