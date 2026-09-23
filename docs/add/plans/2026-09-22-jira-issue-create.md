# Jira Issue Create Implementation Plan

**Goal:** Add Jira issue creation to the SDK, wired into the CLI as `jira create` (single and batch)
and MCP as `jira_create_issue`, with the same field semantics `jira edit` already has.

**Architecture:** Keep the write in `packages/sdk`. Create metadata is reshaped into the same map
`editmeta` returns so field resolution and coercion are reused unchanged, and the new coercion rules
(ADF, sprint, parent) land in the shared table so `edit` gains them too. Creating is non-destructive,
so `--dry-run` previews the resolved payload but no `--force --confirm` gate is added.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Jira Cloud platform REST API v3.

---

## Files

- Create `packages/sdk/src/adf.ts` with a markdown to Atlassian Document Format converter.
- Modify `packages/sdk/src/jira-fields.ts` with ADF, sprint, and issue-link coercion plus the
  required-field check.
- Modify `packages/sdk/src/types.ts` with create metadata schemas and create input/result types.
- Modify `packages/sdk/src/client.ts` with the create metadata, user lookup, and create methods.
- Modify `packages/sdk/src/config.ts` and `.env.example` for `ATLASSIAN_JIRA_PROJECT`.
- Modify `packages/sdk/src/index.ts` to export the new schemas, types, and helpers.
- Create `packages/sdk/tests/adf.test.ts` and `packages/sdk/tests/jira-create.test.ts`.
- Modify `packages/sdk/tests/jira-fields.test.ts` and `packages/sdk/tests/client.test.ts`.
- Create `packages/cli/src/commands/jira-create.ts`.
- Modify `packages/cli/src/app.ts` to mount `jira create`.
- Modify `packages/mcp/src/tools/resources.ts` to add `jira_create_issue`.
- Modify `packages/mcp/README.md` and the root `README.md`.

## Task 1: Markdown To ADF

- [x] Headings, paragraphs with hard breaks, bullet and ordered lists with nesting, fenced code with
      language, blockquotes, and rules.
- [x] Inline code, links, strong, emphasis, and strike.
- [x] Empty input yields a valid empty document rather than an empty text node.

## Task 2: Shared Coercion Rules

- [x] Rich-text fields (`description`, `environment`, textarea customs) take markdown and become ADF;
      an ADF document passes through untouched.
- [x] The sprint field is sent as one numeric id despite publishing `array` of `json`.
- [x] `issuelink` fields, including `parent`, are named by issue key.
- [x] `listRequiredJiraFields` / `listMissingRequiredJiraFields` skip `project`, `issuetype`, and any
      field Jira fills in itself.
- [x] Field errors name the screen they were resolved against.

## Task 3: SDK Client Methods

- [x] `listJiraIssueTypes` and `getJiraCreateMeta` against the createmeta endpoints, paginated and
      cached per client.
- [x] `resolveJiraIssueType` by id or case-insensitive name, failing with `invalid_issue_type`.
- [x] `searchJiraUsers` / `resolveJiraAccountId`, applied to user fields on both create and edit.
- [x] `createJiraIssue` planning, required-field checking, then `POST /rest/api/3/issue`, honouring
      `dryRun`.
- [x] Jira's 400 re-coded to `invalid_parent`, `missing_required_field`, or `invalid_field_value`.
- [x] `createJiraIssues` running the batch per record, continuing past failures.

## Task 4: SDK Tests

- [x] Converter covered directly; coercion and required-field rules covered against fixture metadata.
- [x] `createJiraIssue` asserts both metadata lookups, the POST body per field type, the ADF
      description, and no POST under `dryRun`.
- [x] Each error code asserted with the details a retry needs.
- [x] `createJiraIssues` asserts a failing record does not abort the batch and metadata is fetched
      once.
- [x] `editJiraIssue` asserts an assignee email is resolved to an account id.

## Task 5: CLI

- [x] `jira create --project --type --summary --description/--description-file --parent --field`,
      plus `--from-file`, `--dry-run`, `--json`.
- [x] `--project` defaults to `ATLASSIAN_JIRA_PROJECT`.
- [x] Error output includes the `code` and `details` so recovery is scriptable.
- [x] Batch exits non-zero when any record failed, after attempting every record.
- [x] Mount `create` in the `jira` route map.

## Task 6: MCP

- [x] `jira_create_issue` accepting a single issue or an `issues` batch, with `dryRun`.

## Task 7: Verification

- [x] `bun test` passes.
- [x] `bun run lint` passes.
- [x] `bun run dev:cli -- jira create --help` prints usage.
- [x] Acceptance cases exercised end to end against a local mock of the Jira endpoints.

## Task 8: Review Pass

- [x] Accept every documented key for both createmeta pages (`issueTypes` / `createMetaIssueType`,
      `fields` / `results`, and `values`), which a `values`-only parser would have read as empty.
- [x] Page on the response's own `maxResults` so a server-capped page is not mistaken for the last.
- [x] Expire cached create metadata, since the MCP server outlives a screen change.
- [x] Build one payload for the dry run and the create, with `project` and `issuetype` inside it;
      reject either passed as a field, and reject a shorthand that collides with a `fields` entry.
- [x] Detect rich text by `schema.type: "doc"` as well as by system and custom field type.
- [x] Give an empty list item or blockquote a paragraph, which ADF requires.
- [x] Apply CommonMark flanking rules to emphasis, allow balanced parentheses in a link href, and
      take only the first token of a fence info string.
- [x] Narrow the account id heuristic to the two shapes Atlassian issues.
- [x] Reject unsupported keys and non-string scalars in a `--from-file` record instead of dropping
      them; accept a numeric project id and an ADF description object.
- [x] Extend the `--from-file` and MCP batch guards to every single-issue input, and apply a
      top-level project as the batch default in MCP as the CLI already does.
- [x] Extract the CLI field parsing and error output shared with `jira edit` into one module.
- [x] Cover the above with tests: paging, alternate page keys, 400 translation branches, account id
      resolution failures, payload guards, and the ADF edge cases.

## Assumptions & Decisions

- Create metadata is reshaped into the `editmeta` map instead of getting its own planner, because the
  create screen and the edit screen publish the same field descriptors and forking them would fork
  the coercion table with them.
- Required fields are checked locally before the write so a sub-task without a parent costs no create
  attempt; Jira's own 400 is still re-coded, since a site can require a field the metadata omits.
- Metadata is cached per client rather than per call, so a batch into one project costs two lookups
  in total. The cache lives for the life of the process, which is one CLI invocation.
- No `--notify` flag: Jira's create endpoint has no notification parameter, so the flag would have
  been inert. Create notifications follow the project's notification scheme.
- Success reports `status: "created"` rather than `"ok"`, matching `jira attach` (`uploaded`) and
  `jira sprint create` (`created`); the key, id, and browse URL are in the same object either way.
- Existing value-level error codes (`field_not_settable`, `field_value_not_allowed`,
  `field_value_invalid`) are reused rather than renamed, so a caller that already branches on `edit`
  codes does not need a second vocabulary for create.
