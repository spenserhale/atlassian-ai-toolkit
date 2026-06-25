# AGENTS.md

## Purpose

`atlassian-ai-toolkit` is an AI-first integration for Atlassian Cloud APIs. It provides a typed SDK, an agent-native CLI, and an MCP server for Jira and Confluence, with all API logic centralized in the SDK.

This repo is one toolkit within the larger `Toolkits/` collection. The shared monorepo architecture is documented one level up in `Toolkits/CLAUDE.md`.

## Quick Start

Run from the repo root:

```bash
bun install
bun run build
bun test
bun run lint

bun run dev:cli -- --help
bun run dev:mcp
```

Config: copy `.env.example` to `.env` and set `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_API_TOKEN`.

## Repo Layout

```text
packages/sdk/        Zod types, HTTP client, config resolver, typed errors
packages/cli/        Stricli CLI; thin consumer of the SDK
packages/mcp/        FastMCP stdio server; thin consumer of the SDK
refs/                Ignored reference repos and downloaded examples
```

## API Conventions

The SDK is the source of truth. CLI and MCP code must not contain raw Atlassian REST calls.

Use Atlassian Cloud Basic auth with `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN`. Do not use local tokens or `.env` values with third-party code under `refs/`.

Destructive operations require explicit safeguards:

- Jira issue deletion is permanent. CLI commands must dry-run by default and require `--force` for actual deletion.
- Confluence page deletion moves to trash by default. Permanent purge must be a separate explicit option and require `--force`.
- MCP destructive tools should require an explicit `force: true` parameter and should not be registered until the tool contract includes a safe preview path.

## Done Criteria

- Run `bun run lint` and `bun test` before finishing code changes.
- When adding an SDK operation, wire it into both CLI and MCP or state why not.
- Keep third-party examples in `refs/` only; they are read-only references and are not committed.
