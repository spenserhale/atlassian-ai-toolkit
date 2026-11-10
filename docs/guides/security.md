---
title: Security
description: Read this when changing how credentials are read, stored, or exposed, or when adding a command or MCP tool that touches them.
---

## Credentials

- **Never in argv.** No command accepts a credential as an argument or flag value, because arguments land in shell history and `ps` output. `atlassian auth set` reads values from a terminal prompt (the API token is not echoed) or from stdin with an explicit `--stdin`.
- **The OS keychain is the persistent store without plaintext.** `auth set` writes to macOS Keychain, Linux libsecret, or Windows Credential Manager through `Bun.secrets`. There is no plaintext fallback store: if the keychain is unavailable, `auth set` fails with exit code 3 and points to env vars or `op run`.
- **Explicit sources win.** Process env and `.env` files outrank the keychain, so `op run` and CI behave exactly as before. The keychain is only read for credentials no other source supplied.
- **Never printed.** `auth list`, `config show`, and the `atlassian_config_status` MCP tool report `set`/`missing` and the source, never values. Tests assert that serialized output does not contain the stored value.
- **`auth migrate` does not edit files.** It copies `.env` values into the keychain and lists the files to clean up, so a user decides what to delete.
- **Destructive keychain changes need `--yes`.** `auth delete` refuses without it and supports `--dry-run`.

## MCP server

- The server reads credentials from the keychain but exposes **no tool that writes or deletes secrets**. An agent connected over MCP cannot change stored credentials.
- Destructive Atlassian operations follow the `force` plus matching `confirm` rule in `AGENTS.md`.

## Tests

- Tests never touch the real keychain. SDK and CLI unit tests inject an in-memory `SecretStore`; CLI end-to-end tests spawn the CLI with `ATLASSIAN_KEYCHAIN=0` and only exercise paths that exit before a store call or run with `--dry-run`. Any new spawned CLI or MCP test must set `ATLASSIAN_KEYCHAIN=0` in its env.

## Threat model

The keychain protects credentials at rest: out of repositories, sync folders, backups, and files other tools read. It does not protect against code already running as the user after keychain access has been granted.
