---
title: "0001: Store Atlassian credentials in the OS keychain with Bun.secrets"
description: "Credentials can live in the OS credential store via Bun.secrets, resolved after env and .env."
status: accepted
date: 2026-11-09
decision-makers: "Spenser Hale"
---

## Context

Before this change, every persistent way to give the toolkit its Atlassian credentials was plaintext at rest: a project `.env`, shell profile exports, or literal values in an MCP host `env` block. `op run` works but requires 1Password. The MCP case is the worst: GUI hosts do not inherit the shell, so the usual fix is to paste the API token into the host config file.

Bun 1.3+ ships `Bun.secrets`, which wraps macOS Keychain Services, Linux libsecret, and Windows Credential Manager with no native dependency. The CLI, the standalone binaries, and the MCP server already run on Bun. The same design shipped in `wide-search-toolkit` v0.2.0 (its decision 0007); this record adapts it.

## Options considered

1. **`Bun.secrets`**: built in, cross-platform, no install step, async only. Works only when the process runs on Bun.
2. **`@napi-rs/keyring` or `keytar`**: work on Node, but add native optional dependencies that `bun install` can skip; `keytar` is archived.
3. **Shell out to `security`**: macOS only, and `add-generic-password -w <value>` leaks the value through argv.
4. **Document `op run` only**: no code, but leaves everyone else with plaintext.

## Decision

We will store credentials with `Bun.secrets` under service `atlassian-ai-toolkit`, one entry per env var name, because it is built into the runtime we already require and covers all three desktop OSes without a native dependency.

- **Entries:** `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_API_TOKEN`, grouped as one `auth` resource named `atlassian`. The site URL and email are not secret, but the toolkit has no user config file, and storing them beside the token is what lets the MCP server run with no `env` block. Only the token is hidden at the prompt. Optional settings (`ATLASSIAN_JIRA_PROJECT`, `ATLASSIAN_JIRA_BOARD_ID`, `ATLASSIAN_STORY_POINTS_FIELD`) stay env-only.
- **Precedence:** `SDK overrides > process env > nearest .env > keychain`. A project `.env` is an explicit per-project override, and `op run` and CI keep working unchanged.
- **Lookup:** `loadConfig()` reads only credentials no higher source supplied, in parallel, and treats any store error as `keychain.status: unavailable`. `ATLASSIAN_KEYCHAIN=0` turns the lookup off. `resolveConfig()` stays synchronous.
- **`.env` discovery:** the resolver now walks up from cwd and reads `.env` files itself (nearest wins), so it can label a value's source as `envfile:<path>`. Before, only the cwd `.env` was read, implicitly by Bun.
- **Writes:** only through the CLI `auth` commands. The MCP server reads the keychain and gets a read-only `atlassian_config_status` tool, but no tool that writes or deletes secrets.
- **No** plaintext fallback store, no profiles, and `auth migrate` never edits files.

## Consequences

- MCP host configs no longer need an `env` block.
- Every CLI command and MCP tool calls `await loadConfig()`. SDK consumers on Node, or callers of `resolveConfig()`, get the old behavior.
- A `.env` in a parent directory now applies, where before only the cwd `.env` did.
- macOS may show an access prompt the first time a different binary reads an entry, including after `atlassian upgrade` replaces the standalone binary.
- The keychain protects credentials at rest, not against code already running as the user after access is granted.

## Revisit when

- The CLI or MCP server needs to run on Node.
- Users need several Atlassian sites or accounts at once (profiles).
- Per-upgrade access prompts for the standalone binary become a real complaint.

## Links

- Spec: [OS keychain credentials](../add/specs/2026-11-09-os-keychain-credentials-design.md)
- Guides: [Configuration](../guides/configuration.md), [Security](../guides/security.md)
