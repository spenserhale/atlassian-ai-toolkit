# Atlassian AI Toolkit

AI-first SDK, CLI, and MCP server for Atlassian Jira and Confluence

A Bun monorepo containing a typed SDK, an agent-native CLI, and an MCP server for Atlassian Cloud APIs.

## Packages

| Package | Description |
|---------|-------------|
| [`@atlassian-ai-toolkit/sdk`](./packages/sdk) | Core SDK with types, API client, and business logic |
| [`@atlassian-ai-toolkit/cli`](./packages/cli) | Command-line interface (Stricli) |
| [`@atlassian-ai-toolkit/mcp`](./packages/mcp) | MCP server for AI assistants (FastMCP) |

## Install The CLI

### Recommended: Standalone Binary

No Node.js, no npm, no PATH conflicts. One file built with Bun.

**macOS and Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/spenserhale/atlassian-ai-toolkit/main/scripts/install.sh | sh
```

The script detects your OS + architecture, downloads the matching binary from the latest release, verifies its SHA256, and installs to `$HOME/.local/bin/atlassian`.

Pin a version with `ATLASSIAN_AI_TOOLKIT_VERSION=v0.1.0` or change the install directory with `ATLASSIAN_AI_TOOLKIT_INSTALL=$HOME/bin`.

**Windows:** download `atlassian-windows-x64.exe` from the [latest release](https://github.com/spenserhale/atlassian-ai-toolkit/releases/latest) and put it on your `PATH`.

Available binaries: `atlassian-linux-{x64,arm64}`, `atlassian-darwin-{x64,arm64}`, and `atlassian-windows-x64.exe`.

### Upgrade

Upgrade an installed binary in place from the latest GitHub release (verifies the SHA256 first):

```sh
atlassian upgrade            # apply the latest release
atlassian upgrade --dry-run  # only show current vs latest
```

On Windows, close running instances before upgrading, or re-download the exe from the [latest release](https://github.com/spenserhale/atlassian-ai-toolkit/releases/latest).

### Shell Aliases

For shorter commands, add these aliases to your shell profile (`~/.zshrc` or `~/.bashrc`):

```sh
alias jira='atlassian jira'
alias conf='atlassian confluence'
```

Then `jira get PROJ-123` runs `atlassian jira get PROJ-123`, and `conf get 123456` runs `atlassian confluence get 123456`.

## Configure

Set Atlassian Cloud credentials in your shell:

```sh
export ATLASSIAN_SITE_URL="https://your-site.atlassian.net"
export ATLASSIAN_EMAIL="you@example.com"
export ATLASSIAN_API_TOKEN="your-api-token"
```

Create a scoped API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

## Creating Issues

Create an issue with the same field semantics as `jira edit`: the issue type and every field are
resolved against the project's own create screen, so plain values work and a bad one is rejected
before the write.

```sh
# Preview the full create payload without writing
atlassian jira create --project DMP --type Bug --summary "Login times out" \
  --description-file ./repro.md --field "Task Category=Support" --field "Priority=High" --dry-run --json

# Create it, then hand the key to jira edit or jira attach
atlassian jira create --project DMP --type Bug --summary "Login times out" --json
# {"status":"created","key":"DMP-2470","id":"1234567","url":"https://your-site.atlassian.net/browse/DMP-2470", ...}

# A sub-task, or an issue under an epic
atlassian jira create --project DMP --type Sub-task --summary "Write the migration" --parent DMP-123

# A reviewed batch in one command
atlassian jira create --from-file issues.json --json
```

`--project` defaults to `ATLASSIAN_JIRA_PROJECT`. `--type` takes a display name (case-insensitive) or
an id. `--description` / `--description-file` take markdown and are converted to ADF, which is what
Jira's v3 API requires. Everything else goes through `--field <id|name>=<value>`, including priority,
labels, assignee, story points, sprint, and custom fields; list fields take a comma-separated value
(`--field labels=audit,login`) and a repeated `--field` is rejected rather than silently keeping the
last value. An assignee given as an email address or display name is resolved to an account id.

`issues.json` is `[{"project": "DMP", "issuetype": "Bug", "summary": "...", "fields": {...}}]`. Every
record is attempted, results are reported per record, and the command exits non-zero if any record
failed. A record key outside that set is rejected rather than ignored, so a field value put at the
top level fails loudly instead of vanishing; with `--from-file`, `--project` is the default for
records that name none and the other single-issue flags are refused.

`project` and `issuetype` come from `--project` and `--type`, so passing either through `--field`
is an error rather than a value the create would overwrite.

Rejections carry what a retry needs, so no separate metadata call is required:

| `code` | `details` |
|--------|-----------|
| `invalid_issue_type` | the project's real issue types |
| `missing_required_field` | the required fields the payload left out, with their allowed values |
| `field_not_settable` | the fields that issue type's create screen does accept |
| `field_value_not_allowed` | the field's allowed values |
| `invalid_parent` | Jira's own parent error |

Creating is not destructive, so there is no `--force --confirm` gate. `--dry-run` resolves the whole
payload against the create screen — including the ADF description and every coerced field — and
prints it without sending, so a dry run shows exactly what the real create would write.

## Editing Issue Fields

Set fields by id or display name. Values are coerced to the shape each field's schema requires, read
from the issue's own edit screen, so a single-select takes `Support` rather than `{"value":"Support"}`
and a number takes `2` rather than `"2"`.

```sh
# Preview the resolved payload without writing
atlassian jira edit PROJ-123 --field "Task Category=Support" --field customfield_10105=2 --dry-run --json

# Apply the edit
atlassian jira edit PROJ-123 --field customfield_10105=2

# Apply a reviewed batch of corrections in one command
atlassian jira edit --from-file edits.json --json
```

Field values are coerced the same way on create and on edit: a markdown value for `description` or
another rich-text field becomes ADF, `Sprint` takes a bare sprint id, `parent` takes an issue key,
and an assignee takes an email address, display name, or account id.

`edits.json` is `[{"key": "PROJ-123", "fields": {"Task Category": "Support", "customfield_10105": 2}}]`.
Each key is attempted, per-key results are reported, and the command exits non-zero if any key
failed. Lists are comma-separated (`--field labels=audit,sprint-close`), `json:` passes a raw value
through (`--field customfield_13841=json:{"id":"14501"}`), and an empty value clears a field.

Jira rejects the whole call when one field is unsettable on that issue type, so a rejected field
comes back with the issue's settable fields in the error details:

```json
{
  "status": "error",
  "code": "field_not_settable",
  "message": "\"Story Points\" is not a field that can be set on this issue",
  "details": { "field": "Story Points", "settableFields": [{ "id": "customfield_13841", "name": "Task Category", "type": "option" }] }
}
```

Editing is reversible from the issue history, so no `--force --confirm` gate applies; `--dry-run`
validates the payload against the edit screen without sending it.

## Searching And Sprint Reporting

`jira search --json` reports `total`, `isLast`, and `startAt` alongside the issues, so a truncated
result is detectable rather than inferred. `isLast` is false when the walk stopped at `--limit`, and
`total` is then Jira's approximate count for the query.

```sh
# Trim the response to the fields actually read
atlassian jira search --jql "sprint = 42 AND status = Done" --fields key,summary,status,customfield_10105 --json

# Same flag on sprint issue listing
atlassian jira sprint issues 42 --fields key,summary,status
```

Story point rollups are opt-in, since they cost one pass over the sprint:

```sh
atlassian jira sprint get 42 --points --json
# ... "points": { "committed": 47, "completed": 31, "field": "customfield_10105", "issueCount": 18, "unestimated": 2 }

# Reported in the close preview and result too, measured before any rollover move
atlassian jira sprint close 42 --points --issues PROJ-1,PROJ-2 --move-to-sprint 43
```

Completed points are those on issues whose status category is `done`. The story point field id
varies by site: set `ATLASSIAN_STORY_POINTS_FIELD`, or pass `--points-field customfield_10105`.

Board-scoped sprint commands accept a default board, so the id does not have to be repeated:

```sh
export ATLASSIAN_JIRA_BOARD_ID=1234
atlassian jira sprint current --points --json
atlassian jira sprint list --state active
atlassian jira sprint create --name "Sprint 43" --goal "Ship search"
```

An explicit board (`sprint current 42`, `--board 42`) still wins over the environment; without
either, the command fails with a hint to set `ATLASSIAN_JIRA_BOARD_ID`.

## Attachments

Upload one or more files to a Jira issue. Repeat `--file` for multiple uploads; the stored filename is the file's basename and the MIME type is inferred from its extension.

```sh
# Attach a single file
atlassian jira attach PROJ-123 --file ./screenshot.png

# Attach several files and print the API response
atlassian jira attach PROJ-123 --file ./error.log --file ./har-capture.har --json
```

The MCP tool `jira_add_attachment` takes the same `paths`, plus a `files` array for content an agent generates inline (`filename`, `content`, `encoding: utf8 | base64`).

Confluence pages take one attachment per call:

```sh
atlassian confluence attachment upload --page 123456 --file ./diagram.png
```

Attachments must be enabled on the site, and uploads are subject to the site's maximum attachment size.

## Destructive Actions

Deletes preview by default. Actual deletion requires `--force` and a matching `--confirm` value from the fetched resource.

```sh
# Preview the permanent Jira delete
atlassian jira delete PROJ-123

# Permanently delete the Jira issue
atlassian jira delete PROJ-123 --force --confirm PROJ-123

# Preview moving a Confluence page to trash
atlassian confluence delete 123456

# Move a Confluence page to trash
atlassian confluence delete 123456 --force --confirm 123456

# Permanently purge an already-trashed Confluence page
atlassian confluence delete 123456 --purge --force --confirm 123456
```

## Getting Started From Source

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run the CLI
bun run dev:cli -- --help

# Run the MCP server (stdio mode for Claude Desktop)
bun run dev:mcp
```

The token should be scoped to the smallest set of Jira and Confluence permissions needed for the workflow. Third-party reference implementations live under `refs/`, which is intentionally gitignored so this repo never vendors or executes unreviewed code with local credentials.

## Architecture

```
packages/sdk/     <-- Types, API client, business logic (foundation)
    ^       ^
    |       |
packages/cli/   packages/mcp/
    (Stricli)    (FastMCP)
```

Both the CLI and MCP server are thin wrappers over the SDK. If the REST API
changes, you update the SDK and both consumers get the fix automatically.

## Development

```bash
# Run tests across all packages
bun test

# Build a specific package
cd packages/sdk && bun run build
```

## Adding a New API Operation

1. Add types to `packages/sdk/src/types.ts`
2. Add the client method to `packages/sdk/src/client.ts`
3. Add a CLI command in `packages/cli/src/commands/`
4. Add an MCP tool in `packages/mcp/src/tools/`

Destructive operations must default to a preview path and require an explicit `--force` flag in the CLI or `force: true` in MCP tools.
