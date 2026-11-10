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

Config: store `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_API_TOKEN` in the OS keychain with `bun run dev:cli -- auth set atlassian`, or copy `.env.example` to `.env`. Precedence is process env > nearest `.env` > keychain; `ATLASSIAN_KEYCHAIN=0` skips the keychain. See `docs/guides/configuration.md`.

## Repo Layout

```text
packages/sdk/        Zod types, HTTP client, config resolver, typed errors
packages/cli/        Stricli CLI; thin consumer of the SDK
packages/mcp/        FastMCP stdio server; thin consumer of the SDK
docs/guides/         Configuration and security guides
docs/decisions/      Decision records
docs/add/            Feature specs and plans
refs/                Ignored reference repos and downloaded examples
```

## API Conventions

The SDK is the source of truth. CLI and MCP code must not contain raw Atlassian REST calls.

Use Atlassian Cloud Basic auth with `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN`. Do not use local tokens or `.env` values with third-party code under `refs/`.

Destructive operations require explicit safeguards:

- Jira issue deletion is permanent. CLI commands must preview by default and require `--force --confirm <issue-key-or-id>` for actual deletion.
- Jira sprint deletion is permanent. CLI commands must preview by default and require `--force --confirm <sprint-id>` for actual deletion.
- Confluence page deletion moves to trash by default. Permanent purge must be a separate explicit option and require `--force --confirm <page-id>`.
- MCP destructive tools must preview by default and require `force: true` plus a matching `confirm` field before calling the SDK delete method.

## Credentials

- CLI commands and MCP tools load config with `await loadConfig()`, never `resolveConfig()`, so the OS keychain is consulted.
- Never accept a credential as an argument or flag value. Never add an MCP tool that writes or deletes secrets.
- Tests must never touch the real keychain: inject an in-memory `SecretStore`, and set `ATLASSIAN_KEYCHAIN=0` in the env of every spawned CLI or MCP process.

## Done Criteria

- Run `bun run lint` and `bun test` before finishing code changes.
- When adding an SDK operation, wire it into both CLI and MCP or state why not.
- Keep third-party examples in `refs/` only; they are read-only references and are not committed.
