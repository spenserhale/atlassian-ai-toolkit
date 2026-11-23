# Jira Issue Transition Design

## Problem

The toolkit can create, edit, search, and delete issues, but it cannot move an issue to another
status. Closing a ticket after the work ships therefore falls back to the browser or another MCP.
Moving an issue is also more than a status write. Jira only allows the transitions defined from the
current status, a workflow may call the move "Close" or "Resolve" while the target status is "Done",
and a transition screen can require fields such as Resolution, or DMP's Task Category and Request
Category, which have to be sent with the move.

## Proposal

SDK, in `packages/sdk`:

- `listJiraIssueTransitions(key)` calls `GET /rest/api/3/issue/<key>/transitions?expand=transitions.fields`
  and returns each transition's id, name, target status (with its category), and the fields on its
  screen, marking the required ones.
- `resolveJiraTransition(transitions, to, issue)` is a pure function that matches `to` in this order:
  exact transition id, then transition name, then target status name. Names match
  case-insensitively. A miss fails with `transition_not_available` and lists every available
  transition in both the message and `details.available`. A tie, such as two transitions into Done,
  fails with `transition_ambiguous` and lists the candidates.
- `transitionJiraIssue(key, { to, fields }, { dryRun })` resolves the transition, then plans
  `fields` against the transition screen with `planJiraIssueFieldEdits`. The screen's `fields` map
  has the same per-field shape as `editmeta`, so id or name resolution, coercion, allowed-value
  matching, and user lookup are the same as in `jira edit`. It then sends
  `POST /rest/api/3/issue/<key>/transitions` with `{ transition: { id }, fields }`. A Jira 400 that
  carries a field error map is re-coded the same way create errors are (`missing_required_field` or
  `invalid_field_value`).

CLI:

```text
atlassian jira transition <KEY>
atlassian jira transition <KEY> --to <id|name|status> [--field <id|name>=<value>]... [--dry-run] [--json]
```

MCP: `jira_list_transitions` (read-only) and `jira_transition_issue` (`issueIdOrKey`, `to`,
`fields`, `dryRun`).

## Decisions

- **Screen fields only.** Jira's transition endpoint rejects fields that are not on the transition
  screen. Such a field fails before the request with `field_not_settable` and lists the screen's
  fields. The command does not edit the field first and then transition, because that would be two
  writes and the edit would stay if the transition failed. The documented path is `jira edit`, then
  `jira transition`.
- **No up-front required-field check.** The screen marks fields such as Resolution as required, but
  the issue may already hold a value for some of them. Failing before the request would reject moves
  Jira accepts. Required fields are shown in the listing and in `transition.requiredFields`, and
  Jira's own rejection is re-coded into `missing_required_field`.
- **No `--force --confirm` gate.** A transition can be reversed through the workflow and is recorded
  in the issue history, so it gets the same treatment as `jira edit`: `--dry-run` previews the
  chosen transition and the resolved payload.

## Testing

`packages/sdk/tests/jira-transitions.test.ts` stubs `fetch` and covers matching by id, name, and
target status, the miss and tie errors, the listing URL and summary, the POST body with coerced
fields, a bare transition sending no `fields` key, user-field lookup, dry run sending no POST, a field
that is not on the screen, a transition without a screen, and re-coding of Jira's 400. The CLI and
MCP code is covered by `tsc`, following repo policy.
