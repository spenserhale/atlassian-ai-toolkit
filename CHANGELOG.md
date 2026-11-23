# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 0.9.0 are described in their GitHub releases and commit history.

## [Unreleased]

### Added

- `atlassian jira transition <KEY>` lists the transitions available from an issue's current status, with each one's target status and transition screen fields. `--to <id|name|status>` moves the issue; `--field <id|name>=<value>` fills transition screen fields (for example `resolution=Done`) with the same resolution and coercion as `jira edit`. Supports `--dry-run` and `--json`. A `--to` that matches no available transition fails with `transition_not_available` and lists the valid ones.
- MCP tools `jira_list_transitions` and `jira_transition_issue`.
- MCP tool errors from the SDK now carry the error `code` and `details` as `structuredContent`, so clients get the valid transitions, settable fields, and similar recovery data as data rather than prose.
- SDK: `listJiraIssueTransitions()`, `transitionJiraIssue()`, `resolveJiraTransition()`, and `summarizeJiraTransition()`.

## [0.10.0] - 2026-11-17

### Fixed

- `markdownToAdf` no longer nests a paragraph that follows a list, after a blank line, inside the list's last item. Later paragraphs, including bold label lines, were swallowed the same way until a heading, rule, code fence, quote, or different list type. This affected every rich-text field written from markdown: `jira create`/`jira edit` (including `--from-file`) and the `jira_create_issue`/`jira_edit_issue` MCP tools.

## [0.9.0] - 2026-11-09

### Added

- OS keychain credential storage via `Bun.secrets` (macOS Keychain, Linux libsecret, Windows Credential Manager) under service `atlassian-ai-toolkit`, one entry per env var (`ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`). Precedence is process env > nearest `.env` > keychain. The keychain is only read for credentials no other source supplied, and `ATLASSIAN_KEYCHAIN=0` turns the lookup off.
- `atlassian auth set|list|delete|migrate`:
  - `set` stores credentials from a prompt (the token is hidden) or `--stdin`.
  - `list` shows keychain state and the active source, never values.
  - `delete` requires `--yes`.
  - `migrate` copies `.env` credentials into the keychain without editing files.
  - Every command that changes the keychain supports `--dry-run`.
  - Exit codes are 2 for usage errors and 3 for an unreachable keychain.
- `atlassian config show` prints redacted credential state, sources, `.env` files found, and `keychain.status`.
- MCP tool `atlassian_config_status`: a read-only, redacted credential report. The MCP server reads keychain credentials on every tool call, so host configs no longer need an `env` block. No MCP tool writes or deletes secrets.
- SDK exports: `loadConfig()` and `loadCredentials()` (async and keychain-aware), `resolveCredentials()`, `redactedConfig()`, `SecretStore`, `bunSecretStore()`, `readKeychainValues()`, and `AtlassianConfigError`.
- Configuration and security guides, and decision record 0001.

### Changed

- Every CLI command and MCP tool now resolves configuration with `await loadConfig()` instead of `resolveConfig()`. `resolveConfig()` stays synchronous and gains `keychainValues`/`keychain` options; its result now also carries `credentialSources`, `keychain`, and `envFiles`.
- The resolver reads `.env` files itself, walking up from the current directory with the nearest file winning. Before, only the current directory's `.env` applied, loaded implicitly by Bun.
- `handleError` exits 3 for configuration errors.
