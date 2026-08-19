# CLI Self-Upgrade Implementation Plan

**Goal:** Add `atlassian upgrade` so installed standalone binaries update themselves from the latest GitHub release.

**Architecture:** Pure CLI feature — no SDK or MCP changes because it is a GitHub Releases concern, not an Atlassian API operation. A new `version.ts` holds the single source of the CLI version string used by both `--version` and the upgrade check.

**Tech Stack:** Bun, TypeScript, Stricli, node:crypto/node:fs/promises, GitHub REST API.

---

## Files

- Create `packages/cli/src/version.ts` with `CLI_VERSION`.
- Create `packages/cli/src/commands/upgrade.ts`.
- Modify `packages/cli/src/app.ts` to mount `upgrade` and use `CLI_VERSION` for `versionInfo`.
- Modify `README.md` with an Upgrade section.

## Task 1: Version constant

- [x] Extract `CLI_VERSION` to `packages/cli/src/version.ts`; `app.ts` `versionInfo` consumes it.

## Task 2: Upgrade command

- [x] Map `process.platform`/`process.arch` to the release asset name (same naming as `scripts/install.sh`).
- [x] Fetch latest release from GitHub API; semver-compare tag vs `CLI_VERSION`.
- [x] `--dry-run` and up-to-date paths report status only (`would_upgrade` / `up_to_date`), `--json` supported.
- [x] Apply path: download binary + `.sha256` asset, verify SHA256, refuse on mismatch, refuse under `bun`, write temp file next to `process.execPath`, chmod 755, rename over the executable; rename failures suggest closing instances or the install script.

## Task 3: Mount and docs

- [x] Register `upgrade` in the top-level route map in `app.ts`.
- [x] Add Upgrade section to root README.

## Task 4: Verification

- [x] `bun run lint` passes.
- [x] `bun test` passes (24 tests; no SDK changes).
- [x] `bun run dev:cli -- upgrade --dry-run` reports `up_to_date` against the live GitHub API.
- [x] `atlassian --help` lists `upgrade`.

## Assumptions & Decisions

- GitHub latest-release API (unauthenticated, 60 req/hr per IP) is fine for a manual upgrade command.
- Verify-then-replace (temp file + rename in the same directory) keeps the installed binary intact on any failure.
- No SDK/MCP wiring: not an Atlassian operation (see spec).
- Windows replace-while-running is expected to fail; the error guides users to re-download, and the README documents it.
- Bootstrap note: binaries ≤ v0.2.0 lack the command, so the first upgrade to a release containing it still uses the install script.
