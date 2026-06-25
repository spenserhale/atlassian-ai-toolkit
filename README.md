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

The script detects your OS + architecture, downloads the matching binary from the latest release, verifies its SHA256, and installs to `$HOME/.local/bin/atlassian-ai`.

Pin a version with `ATLASSIAN_AI_TOOLKIT_VERSION=v0.1.0` or change the install directory with `ATLASSIAN_AI_TOOLKIT_INSTALL=$HOME/bin`.

**Windows:** download `atlassian-ai-windows-x64.exe` from the [latest release](https://github.com/spenserhale/atlassian-ai-toolkit/releases/latest) and put it on your `PATH`.

Available binaries: `atlassian-ai-linux-{x64,arm64}`, `atlassian-ai-darwin-{x64,arm64}`, and `atlassian-ai-windows-x64.exe`.

## Configure

Set Atlassian Cloud credentials in your shell:

```sh
export ATLASSIAN_SITE_URL="https://your-site.atlassian.net"
export ATLASSIAN_EMAIL="you@example.com"
export ATLASSIAN_API_TOKEN="your-api-token"
```

Create a scoped API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

## Destructive Actions

Deletes preview by default. Actual deletion requires `--force` and a matching `--confirm` value from the fetched resource.

```sh
# Preview the permanent Jira delete
atlassian-ai jira delete PROJ-123

# Permanently delete the Jira issue
atlassian-ai jira delete PROJ-123 --force --confirm PROJ-123

# Preview moving a Confluence page to trash
atlassian-ai confluence delete 123456

# Move a Confluence page to trash
atlassian-ai confluence delete 123456 --force --confirm 123456

# Permanently purge an already-trashed Confluence page
atlassian-ai confluence delete 123456 --purge --force --confirm 123456
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
