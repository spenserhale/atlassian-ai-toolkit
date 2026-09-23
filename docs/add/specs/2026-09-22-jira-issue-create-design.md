# Jira Issue Create Design

## Problem

The CLI covers `get | attach | delete | edit | search | sprint`, so an agent can correct, search,
attach, and manage sprints from one tool, but it cannot open the ticket in the first place. Creating
an issue still has to go through the Rovo MCP connector, which is OAuth-backed, frequently
unauthenticated in a given session, and whose project-config endpoints answer `403 The app is not
installed on this instance` on our site. The CLI authenticates with a static API token and has none
of those failure modes, so create is the last gap that forces a fallback.

Creating is also not a passthrough, for the same reason editing was not. The payload shape depends on
the project and issue type: the issue type has to be named by id, the description has to be an
Atlassian Document rather than a string, and a field that is missing from that issue type's create
screen fails the whole call. A caller that guesses wrong gets a 400 that names no useful recovery.

## Proposal

Add a create path to the SDK built on the project's own create metadata, reusing the field
resolution and coercion that already back `jira edit`.

- `listJiraIssueTypes(project)` — `GET /rest/api/3/issue/createmeta/<project>/issuetypes`, paginated.
- `getJiraCreateMeta(project, issueTypeId)` —
  `GET /rest/api/3/issue/createmeta/<project>/issuetypes/<id>`, returned in the same shape
  `editmeta` reports so `planJiraIssueFieldEdits` plans a create unchanged.
- `createJiraIssue(input, opts)` — resolve the type, plan the fields, check the create screen's
  required fields, then `POST /rest/api/3/issue`. `opts.dryRun` returns the plan without sending.
- `createJiraIssues(inputs, opts)` — the same per record, collecting per-record results and
  continuing past failures, matching `editJiraIssues`.

Both metadata lookups are cached per client, so a batch into one project pays for them once rather
than three round trips per issue. The cache entries expire after ten minutes: a CLI run never lives
that long, while the MCP server holds one client for hours and a create screen can change under it.

Atlassian's v3 spec keys the issue type page `issueTypes` and the field page `fields`, while some
responses key both `values`. Reading one key only would yield a silently empty screen — every create
failing `invalid_issue_type`, or every field reported unsettable — so every accepted key is
normalised onto one. Paging stops on a page shorter than the page size the response itself reports,
rather than the size that was requested, since Jira may cap a page below what was asked for.

Three coercion rules are added to the shared table rather than to the create path, so `edit` gets
them too:

- Rich-text fields (`description`, `environment`, textarea custom fields) take markdown and are
  converted to ADF, because Jira's v3 API rejects a plain string there. The converter is a small
  dependency-free module covering the markdown a description actually uses.
- The agile sprint field publishes `array` of `json` but accepts a single sprint id on write, so it
  is coerced to one number instead of the array its own schema implies.
- `issuelink` fields, which is how `parent` is published, are named by issue key.

User fields are resolved before planning: an `assignee` given as an email address or display name is
looked up through `GET /rest/api/3/user/search` and replaced with its account id, so the common
reason to go look something up first disappears. An account id passes straight through.

CLI:

```text
atlassian jira create --project <KEY> --type <name|id> --summary <text>
                      [--description <text> | --description-file <path>]
                      [--field <id|name>=<value>]... [--parent <KEY>]
                      [--from-file <path>] [--dry-run] [--json]
```

`--project` falls back to `ATLASSIAN_JIRA_PROJECT`, the way `ATLASSIAN_JIRA_BOARD_ID` already backs
the sprint commands. `--from-file` takes
`[{"project": "DMP", "issuetype": "Bug", "fields": {...}}]` and reports per record, exiting non-zero
after attempting every record.

MCP: `jira_create_issue` with `project`/`issueType`/`summary`/`description`/`parent`/`fields`, or
`issues` for the batch, plus `dryRun`.

## Errors

Errors keep the `{status, code, message, details}` convention so callers branch on `code`. The new
codes carry the recovery data the Rovo connector would otherwise be needed for:

- `invalid_issue_type` — details list the project's real issue types.
- `missing_required_field` — details list the required fields the payload left out, with their
  allowed values. Checked against create metadata before the write, so a sub-task without a parent
  fails without spending a create; Jira's own 400 is re-coded to the same shape when it slips past.
- `invalid_parent` — Jira's parent error, separated from the generic 400.
- `field_not_settable`, `field_value_not_allowed`, `field_value_invalid` — inherited from `edit`,
  with the create screen named in the message.
- `user_not_found`, `user_ambiguous` — an assignee that resolves to no user or several.

## Safety

Creating is not destructive and there is nothing to confirm against, so no `--force --confirm` gate,
matching `jira edit` and `jira sprint create`. It is still a write other people see, so `--dry-run`
resolves the entire payload — issue type id, coerced fields, ADF description, resolved account ids —
and prints it unsent. The dry run and the create share one payload object, so nothing can be added
between the preview and the write; `project` and `issuetype` are part of it rather than appended
afterwards, and passing either as a field is an error instead of a value the create would overwrite.

`--notify` is deliberately absent: Jira's create endpoint has no notification parameter, unlike the
edit endpoint's `notifyUsers`. Create notifications are governed by the project's notification
scheme, so a flag would have been inert.

## Testing

SDK tests stub `globalThis.fetch` and route by URL rather than call order, since metadata is cached.
They assert the two metadata lookups plus one `POST`, the payload per field type, the ADF
description, the sprint and parent shapes, account id resolution, dry run sending no `POST`, the
per-code failures, and a batch continuing past a bad record. The markdown converter and the required
field check are tested directly. CLI and MCP remain covered by `tsc` per repo policy.
