# OS Keychain Credentials Design

## Problem

Atlassian credentials could only live in places that are plaintext at rest: env vars exported from a
shell profile, a `.env` file, or an MCP host `env` block. GUI MCP hosts do not inherit the shell, so
the API token usually ended up pasted into the host config file.

## Proposal

Store credentials in the OS credential store through `Bun.secrets`, and have the CLI and MCP server
find them with no `.env` and no `env` block. Reasoning: [decision 0001](../../decisions/0001-os-keychain-credential-store.md).

### SDK

- `secrets.ts`: `SecretStore` (`description`, `get`, `set`, `delete`), `bunSecretStore(service)` over
  `globalThis.Bun?.secrets` that wraps every failure in `AtlassianConfigError` with a macOS/Linux hint,
  `CREDENTIAL_KEYS` (`ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`), the `atlassian`
  resource, and `readKeychainValues(store, names)`, which reads in parallel and never throws.
- `config.ts`:
  - `resolveCredentials(overrides, options)` resolves credentials without validating them.
  - `resolveConfig(overrides, options)` stays synchronous and accepts `keychainValues` and `keychain`.
  - `loadCredentials(options)` and `loadConfig(options)` are async and read the keychain only for
    credentials that overrides, process env, and `.env` did not supply.
  - The lookup is skipped when `secretStore: null` or `ATLASSIAN_KEYCHAIN` is `0|false|no|off` in
    env or `.env`.
  - Precedence is overrides > process env > nearest `.env` > keychain. Source labels are `override`,
    `env`, `envfile:<path>`, `keychain`, and `missing`.
  - The resolved config carries `credentialSources`, `keychain: { status, error? }`, and `envFiles`.
    `redactedConfig()` reports the same with values replaced by `set` or `missing`.
- `AtlassianConfigError` (code `CONFIG_ERROR`, `hint`, `reason`).

### CLI

- `auth set <resource> [--key] [--stdin] [--dry-run] [--json]`:
  - On a TTY it prompts for each key in raw mode, writing labels to stderr; only the API token is
    hidden.
  - `--stdin` reads one trimmed value and needs `--key` for a multi-key resource (exit 2 with the
    exact command as the hint).
  - With no TTY and no `--stdin` it exits 2.
  - It validates the site URL and email, and reports `stored` or `would_store` with `shadowed_by`
    when env or `.env` still wins.
- `auth list [--json|--csv]` shows keychain `set|missing|unknown` and the active source, never values.
- `auth delete <resource> [--key] --yes [--dry-run]` refuses without `--yes` (exit 2) and reports
  `deleted` or `not_found`.
- `auth migrate [--dry-run] [--overwrite]` stores credentials whose active source is a `.env` file,
  skips existing entries unless `--overwrite`, ignores process env, and returns `clean_up` files
  without editing them.
- `config show [--json]` prints the redacted resolution.
- Exit codes: 1 runtime, 2 usage, 3 config. `handleError` maps `AtlassianConfigError` to 3.
- Every command loads config with `await loadConfig()`.

### MCP

- Every tool loads config per call with `await loadConfig()`, so a rotated token applies without a
  restart.
- New read-only tool `atlassian_config_status` returns the redacted resolution.
- No tool writes or deletes secrets.

## Testing

- SDK tests use an in-memory store to cover: the keychain resolving when env and `.env` are empty,
  precedence, requesting only missing keys, no store calls when disabled, a throwing store reporting
  `unavailable` while env still works, nearest-`.env` lookup, and the Bun-autoloaded `.env` label.
- CLI unit tests for `lib/auth.ts` cover: trimming, `--dry-run`, empty and invalid input,
  `shadowed_by`, `list` output never containing values, an unavailable store, `delete`, and
  `migrate`.
- CLI e2e tests spawn the CLI with `ATLASSIAN_KEYCHAIN=0` to cover: no TTY, multi-key `--stdin`
  without `--key`, `--stdin --dry-run` not echoing the value, `delete` without `--yes`, an unknown
  resource, JSON errors, and `config show`.
- Manual macOS run: store dummies with `--stdin`; check `auth list`, `security
  find-generic-password`, and `config show`; check that an MCP stdio client sees
  `configured: true` with no env; test the hidden prompt under `script`; then `auth delete --yes`.
