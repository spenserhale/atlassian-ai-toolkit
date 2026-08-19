# CLI Self-Upgrade Design

## Problem

The CLI ships as standalone binaries installed via `scripts/install.sh` from GitHub Releases. Until now the only way to update was re-running the install script (or a package manager the project does not use). Comparable CLIs, like Zendesk's, self-update with a single command.

## Proposal

Add a top-level `atlassian upgrade` command that:

1. Fetches the latest release from the GitHub API (`/repos/spenserhale/atlassian-ai-toolkit/releases/latest`).
2. Compares the release tag against the compiled-in `CLI_VERSION` (new `packages/cli/src/version.ts`, shared with `versionInfo` in `app.ts`).
3. If newer, downloads the asset matching the current platform/arch (same naming as `scripts/install.sh`: `atlassian-{darwin,linux}-{x64,arm64}`, `atlassian-windows-x64.exe`), verifies its SHA256 against the `.sha256` release asset, then atomically replaces `process.execPath` via write-to-temp + `rename`.
4. `--dry-run` reports current vs latest without applying; `--json` is supported like other commands.

## Safety

- Checksum mismatch aborts before touching the installed binary.
- Refuses to run when the executable is `bun` (dev mode) and points at the install script instead.
- The replace is a same-directory rename so a failed download never corrupts the existing binary.
- Windows cannot replace a running exe; the error message tells the user to close instances or re-download.

## Why CLI-only

This is not an Atlassian API operation, so it does not belong in the SDK, and MCP servers are managed by their host configuration, so there is no MCP equivalent. (Repo convention requires SDK operations to be wired into CLI and MCP; this is not an SDK operation.)

## Testing

CLI has no execution test harness (repo policy: `tsc` via lint). Verified via `bun run dev:cli -- upgrade --dry-run` against the live GitHub API and `atlassian --help` registration.
