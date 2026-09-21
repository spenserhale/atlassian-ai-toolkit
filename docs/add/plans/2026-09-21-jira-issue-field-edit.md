# Jira Issue Field Edit Implementation Plan

**Goal:** Add schema-aware Jira issue field editing to the SDK, wired into the CLI as
`jira edit` (single and batch) and MCP as `jira_edit_issue`.

**Architecture:** Keep the write in `packages/sdk`. Field resolution and value coercion live in a
pure module driven by `/rest/api/3/issue/<key>/editmeta`, so the CLI and MCP stay thin and the
coercion table is unit-testable without HTTP. Editing is non-destructive, so `--dry-run` previews
the resolved body but no `--force --confirm` gate is added.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Jira Cloud platform REST API v3.

---

## Files

- Create `packages/sdk/src/jira-fields.ts` with edit-meta field resolution and value coercion.
- Modify `packages/sdk/src/types.ts` with edit-meta schemas and edit input/result types.
- Modify `packages/sdk/src/errors.ts` with a field error carrying recovery details.
- Modify `packages/sdk/src/client.ts` with `getJiraIssueEditMeta`, `editJiraIssue`, `editJiraIssues`.
- Modify `packages/sdk/src/index.ts` to export the new schemas, types, and helpers.
- Create `packages/sdk/tests/jira-fields.test.ts` for the pure coercion and resolution rules.
- Modify `packages/sdk/tests/client.test.ts` with fetch-based edit tests.
- Create `packages/cli/src/commands/jira-edit.ts`.
- Modify `packages/cli/src/app.ts` to mount `jira edit`.
- Modify `packages/mcp/src/tools/resources.ts` to add `jira_edit_issue`.
- Modify `packages/mcp/README.md` and the root `README.md`.

## Task 1: SDK Types And Errors

- [x] Add `JiraFieldSchemaSchema`, `JiraEditMetaFieldSchema`, `JiraIssueEditMetaSchema`.
- [x] Add `JiraIssueFieldEdits`, `JiraResolvedFieldEdit`, `JiraIssueEditPlan`, `JiraIssueEditResult`,
      `JiraIssueEditBatchResult`, `JiraIssueEditOptions`.
- [x] Add `AtlassianFieldError` carrying a machine-readable code plus details.

## Task 2: Field Resolution And Coercion

- [x] Resolve an input key as a field id, else a case-insensitive display name; fail ambiguous names
      with the candidate ids.
- [x] Fail unknown or unsettable fields with `field_not_settable` and `settableFields` in details.
- [x] Coerce by `schema.type` / `schema.items`; pass objects and arrays through untouched; support a
      `json:` escape hatch and `null` to clear a field.
- [x] Match `allowedValues` case-insensitively and rewrite to canonical casing; fail a miss with the
      allowed list.

## Task 3: SDK Client Methods

- [x] `getJiraIssueEditMeta` against `GET /rest/api/3/issue/<key>/editmeta`.
- [x] `editJiraIssue` planning then `PUT /rest/api/3/issue/<key>`, honouring `dryRun` and
      `notifyUsers`.
- [x] `editJiraIssues` running the batch per key, continuing past failures and reporting per key.

## Task 4: SDK Tests

- [x] Coercion table and name resolution tested against fixture edit metadata.
- [x] Unsettable field error includes `settableFields`.
- [x] `editJiraIssue` asserts the editmeta GET, the PUT body shape, and no PUT under `dryRun`.
- [x] `editJiraIssues` asserts a failing key does not abort the remaining keys.

## Task 5: CLI

- [x] `jira edit <KEY> --field id=value` repeatable, plus `--from-file`, `--dry-run`, `--json`,
      `--notify`.
- [x] Error output includes the field error `code` and `details` so recovery is scriptable.
- [x] Batch exits non-zero when any key failed, after attempting every key.
- [x] Mount `edit` in the `jira` route map.

## Task 6: MCP

- [x] `jira_edit_issue` accepting a single key + fields or an `edits` batch, with `dryRun`.

## Task 7: Verification

- [x] `bun test` passes.
- [x] `bun run lint` passes.
- [x] `bun run dev:cli -- jira edit --help` prints usage.

## Assumptions & Decisions

- Coercion is driven by `editmeta` rather than the field id, because custom field ids differ per site
  and only the schema says whether a value is a scalar, an option object, or an array.
- No `--force --confirm` gate: a field edit is reversible from the issue history, unlike the deletes
  and sprint closes that carry one.
- The batch form continues past a failing key so one bad issue type does not strand the rest of an
  audit; the exit code still reports the partial failure.
