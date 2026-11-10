---
title: Configuration
description: Read this when setting up Atlassian credentials for the CLI or an MCP host, storing them in the OS keychain, or when the CLI works but the MCP server cannot see the same credentials.
---

## Purpose

Read this guide when configuring a machine for `atlassian-ai-toolkit`, comparing CLI and MCP setup, or debugging a credential that works in one surface but not the other.

## Settings

| Variable | Required | Where it can live | Notes |
|---|---|---|---|
| `ATLASSIAN_SITE_URL` | Yes | env, `.env`, OS keychain | `https://your-site.atlassian.net` |
| `ATLASSIAN_EMAIL` | Yes | env, `.env`, OS keychain | Account email the API token belongs to |
| `ATLASSIAN_API_TOKEN` | Yes | env, `.env`, OS keychain | Create one at <https://id.atlassian.com/manage-profile/security/api-tokens> |
| `ATLASSIAN_STORY_POINTS_FIELD` | No | env, `.env` | Defaults to `customfield_10105` |
| `ATLASSIAN_JIRA_PROJECT` | No | env, `.env` | Default project for `jira create` |
| `ATLASSIAN_JIRA_BOARD_ID` | No | env, `.env` | Default board for board-scoped sprint commands |
| `ATLASSIAN_KEYCHAIN` | No | env, `.env` | Set to `0`, `false`, `no`, or `off` to skip the keychain lookup |

## The shared resolver

The CLI, the MCP server, and SDK callers that use `loadConfig()` share one resolver in `packages/sdk/src/config.ts`. Precedence for each credential:

```
explicit SDK overrides
  > process environment
  > nearest .env, walking up from the current working directory
  > OS keychain (service "atlassian-ai-toolkit")
```

The keychain is only asked for credentials that the environment and `.env` files did not supply, so an explicit value never triggers a keychain prompt. If the keychain is unavailable (no Secret Service on Linux, a locked keychain, a non-Bun runtime), the lookup is skipped and the rest of the chain works as before. See [decision 0001](../decisions/0001-os-keychain-credential-store.md).

Bun loads the `.env` in the current directory into the process environment on its own. When a process value matches that `.env` value, the toolkit reports it as coming from the file (`envfile:<path>`), so `auth list` and `auth migrate` can tell you which file holds it.

Check the result at any time. Values are always redacted:

```bash
atlassian config show          # credential state, sources, keychain status
atlassian config show --json   # the same, for agents
```

## Setup options at a glance

| Option | CLI | MCP | Plaintext at rest? | When to use |
|---|---|---|---|---|
| **OS keychain (`atlassian auth set`)** | Yes | Yes, with no `env` block | No; encrypted by the OS | Default persistent setup on a desktop machine |
| Terminal exports (`export ATLASSIAN_...=`) | Yes | Only if the host inherited that shell | No file | Quick session |
| `op run --env-file=<op-reference-template>` | Yes | Yes, as a wrapper command | No rendered file | Credentials already in 1Password; headless machines |
| MCP host `env` block | No | Yes | Yes, in the host config | Hosts where the keychain is unavailable |
| Project `.env` | Yes, walking up from cwd | Only if the server's cwd is inside the project | Yes | Per-project override |

Every option uses the same names (keychain entries are named by their env var), so a value moved from one option to another keeps working.

## OS keychain setup

`atlassian auth` stores credentials with `Bun.secrets`: macOS Keychain Services, Linux libsecret (GNOME Keyring, KWallet), or Windows Credential Manager. Each entry uses service `atlassian-ai-toolkit` and the env var name as the account, for example `atlassian-ai-toolkit` / `ATLASSIAN_API_TOKEN`. On macOS you can see and delete them in Keychain Access.app, or check from a shell:

```bash
security find-generic-password -s atlassian-ai-toolkit -a ATLASSIAN_API_TOKEN
```

The site URL and email are not secret, but they are stored next to the token so neither the CLI nor the MCP server needs any environment at all.

### Interactive prompt

On a terminal, `auth set` prompts for each credential. The API token is hidden as you type or paste; the site URL and email echo:

```bash
atlassian auth set atlassian
# ATLASSIAN_SITE_URL: https://your-site.atlassian.net
# ATLASSIAN_EMAIL: you@example.com
# ATLASSIAN_API_TOKEN:            (nothing is shown)
# stored ATLASSIAN_SITE_URL in os-keychain:atlassian-ai-toolkit
# ...

atlassian auth set atlassian --key ATLASSIAN_API_TOKEN   # rotate just the token
```

### Non-interactive: `--stdin`

Scripts and agents pipe one value per call with `--stdin` and name it with `--key`:

```bash
pbpaste | atlassian auth set atlassian --key ATLASSIAN_API_TOKEN --stdin     # macOS clipboard
op read 'op://Private/Atlassian/credential' | atlassian auth set atlassian --key ATLASSIAN_API_TOKEN --stdin
printf '%s\n' https://your-site.atlassian.net | atlassian auth set atlassian --key ATLASSIAN_SITE_URL --stdin
printf '%s\n' you@example.com | atlassian auth set atlassian --key ATLASSIAN_EMAIL --stdin
```

Without a terminal and without `--stdin`, `auth set` exits 2 instead of hanging; stdin is never read implicitly. A value is never accepted as an argument or flag value, because arguments land in shell history and `ps` output. Add `--dry-run` to validate without writing.

### Commands

| Command | What it does |
|---|---|
| `atlassian auth set <resource> [--key NAME] [--stdin] [--dry-run] [--json]` | Store credentials. Validates the site URL and email. Output flags a value that an env var or `.env` still overrides (`shadowed_by`). |
| `atlassian auth list [--json \| --csv]` | Every credential with keychain `set`/`missing`/`unknown` and its active source. Never prints values. |
| `atlassian auth delete <resource> [--key NAME] --yes [--dry-run] [--json]` | Remove keychain entries; reports `deleted` or `not_found`. Refuses without `--yes`. |
| `atlassian auth migrate [--dry-run] [--overwrite] [--json]` | Copy credentials whose active source is a `.env` file into the keychain. Skips keys already stored unless `--overwrite`. Leaves process-environment values (op run, CI) alone. Does not edit files; lists them under `clean_up`. |
| `atlassian config show [--json]` | Redacted credential state, sources, `.env` files found, and `keychain.status`. |

The only resource is `atlassian`, with keys `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_API_TOKEN`.

Exit codes: `0` success, `1` runtime or upstream failure, `2` usage error (bad resource or key, missing `--yes`, no terminal), `3` configuration error (keychain unreachable).

### Moving off a plaintext `.env`

```bash
atlassian auth migrate --dry-run   # see what would move
atlassian auth migrate             # store them
# delete the listed keys from each clean_up file: a .env value keeps overriding the keychain until you do
atlassian auth list                # active source should now read "keychain"
```

### Keychain caveats

- **Access prompts (macOS).** The binary that created an entry reads it silently. A different binary may trigger a "wants to use your confidential information" dialog the first time, for example after a Bun upgrade, after `atlassian upgrade` replaces the standalone binary, or when a GUI MCP host launches the server. Choose **Always Allow**.
- **Linux** needs a running Secret Service daemon. Headless servers and CI usually have none; there, `config show` reports `keychain.status: unavailable`, and you should use env vars or `op run`.
- **Runtime.** The lookup needs Bun. The CLI, the standalone binaries, and the MCP server all run on Bun; SDK consumers on Node skip the keychain silently.
- **Threat model.** The keychain keeps credentials out of files that get committed, synced, backed up, or read by other tools. It does not protect against code already running as your user once access has been granted.

## MCP setup

The MCP server loads configuration on every tool call, so a token rotated with `atlassian auth set` applies without restarting the host. With credentials in the keychain, the host config needs no `env` block. This is the recommended setup:

```json
{
  "mcpServers": {
    "atlassian-ai-toolkit": {
      "command": "bun",
      "args": ["run", "/abs/path/atlassian-ai-toolkit/packages/mcp/src/index.ts"]
    }
  }
}
```

Call the `atlassian_config_status` tool to see whether the server found credentials and where they came from. It never returns values. The MCP server has no tool that writes or deletes keychain entries; use the CLI for that.

If the keychain is unavailable on that machine, fall back to an `env` block or an `op run` wrapper:

```json
{
  "mcpServers": {
    "atlassian-ai-toolkit": {
      "command": "op",
      "args": ["run", "--env-file=/Users/you/.config/atlassian-ai-toolkit/op.env.tpl", "--", "bun", "run", "/abs/path/atlassian-ai-toolkit/packages/mcp/src/index.ts"]
    }
  }
}
```
