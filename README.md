# Atlassian AI Toolkit

AI-first SDK, CLI, and MCP server for Atlassian Jira and Confluence

A Bun monorepo containing a typed SDK, an agent-native CLI, and an MCP server for Atlassian Cloud APIs.

## Packages

| Package | Description |
|---------|-------------|
| [`@atlassian-ai-toolkit/sdk`](./packages/sdk) | Core SDK with types, API client, and business logic |
| [`@atlassian-ai-toolkit/cli`](./packages/cli) | Command-line interface (Stricli) |
| [`@atlassian-ai-toolkit/mcp`](./packages/mcp) | MCP server for AI assistants (FastMCP) |

## Getting Started

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

Copy `.env.example` to `.env` and set `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_API_TOKEN`.

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
