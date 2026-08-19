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
