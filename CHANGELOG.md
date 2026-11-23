# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 0.9.0 are described in their GitHub releases and commit history.

## [Unreleased]

## [0.11.0] - 2026-11-23

### Added

- `atlassian jira transition <KEY>` lists the transitions available from an issue's current status, with each one's target status and transition screen fields. `--to <id|name|status>` moves the issue; `--field <id|name>=<value>` fills transition screen fields (for example `resolution=Done`) with the same resolution and coercion as `jira edit`. Supports `--dry-run` and `--json`. A `--to` that matches no available transition fails with `transition_not_available` and lists the valid ones.
- MCP tools `jira_list_transitions` and `jira_transition_issue`.
- MCP tool errors from the SDK now carry the error `code` and `details` as `structuredContent`, so clients get the valid transitions, settable fields, and similar recovery data as data rather than prose.
- SDK: `listJiraIssueTransitions()`, `transitionJiraIssue()`, `resolveJiraTransition()`, and `summarizeJiraTransition()`.
- **`atlassian confluence get` returns the page body.** Markdown is the default, with `--format storage|adf` as alternatives. Every read includes the version number.
  - **Size guard:** bodies over 12,000 characters print the outline with section sizes, plus a hint. `--full` turns it off.
  - **Section reads:** `--outline` and `--section` (by heading, `Parent > Child` path, or path with `[n]`) return part of a page. `--meta` returns no body, and `--draft` reads the unpublished draft.
  - **Lossy content:** content markdown cannot express shows as a visible `[[cf:...]]` placeholder and is counted in `lossy`.
- **`atlassian confluence search`:**
  - `--cql`, or `--text` with `--space` and `--type`.
  - `--limit` (default 10) and cursor paging, with an `isLast` / `nextCursor` envelope.
  - `--fields` (`id`, `title`, `space`, `type`, `modified`, `excerpt`, `url`, `version`, `ancestors`, `status`).
  - `--excerpt none|short|full`. `short` is 90 characters with highlight markers removed.
- **`atlassian confluence create`:**
  - `--parent` (the space comes from the parent) or `--space`.
  - A markdown, storage, or ADF body, plus `--draft` and `--label`.
  - `--dry-run` shows the space, the ancestor path, and the body size.
  - Errors: `title_exists`, `parent_not_found`, `space_not_found`, `permission_denied`, and `body_too_large`.
- **`atlassian confluence edit`:**
  - **Targeted edits** leave the rest of the stored page untouched, macros and images included: `--replace-section`, `--append`, `--prepend`, `--find` / `--replace` (with `--all`), and `--title`.
  - **Whole-body replace** requires `--expect-version`.
  - **Errors:**
    - `version_conflict`, `approval_required`, and `write_outcome_unknown`;
    - `lossy_replace` (unless `--allow-lossy`), `placeholder_in_body`, and `legacy_editor_page`;
    - `section_not_found`, `section_ambiguous`, `no_match`, and `multiple_matches`.
  - **Retry:** a targeted edit other than a section replace retries once when the page changed during the write.
  - **Drafts:** the output warns when an unpublished draft exists.
- MCP tools `confluence_search`, `confluence_create_page`, and `confluence_edit_page`. `confluence_get_page` gains the read options.
- SDK:
  - page methods: `getConfluencePageContent()`, `searchConfluence()`, `createConfluencePage()`, `editConfluencePage()`;
  - `adfToMarkdown()` with `lossy` reporting, plus section helpers;
  - pure edit operations on ADF.
- `markdownToAdf` gains backslash escapes, task lists, and GitHub tables, so `jira create` and `jira edit` gain them too.

### Changed

- **Errors:** CLI errors share one serializer, so `--json` errors carry `details` and `hint` together. Config errors still exit 3.
- **Backslash escapes:** in markdown written to Jira, a backslash before punctuation is now an escape, as CommonMark specifies.
- **Code fences:** a fenced code block closes only on a fence at least as long as the opening one.
- **`confluence get`:** it no longer prints only id, title, and status. It prints the full header and the body.

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
