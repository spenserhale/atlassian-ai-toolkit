# Jira Sprint Points Rollup Implementation Plan

**Goal:** Report committed and completed story points for a sprint from the SDK, surfaced on
`sprint get` and `sprint close` in the CLI and on the matching MCP tools.

**Architecture:** Add one read-only SDK method over the existing paginated sprint issue listing.
Opt-in per call, since the rollup costs a full pass over the sprint.

**Tech Stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Jira Cloud Agile REST API.

---

## Files

- Modify `packages/sdk/src/types.ts` with `JiraSprintPoints` and its options.
- Modify `packages/sdk/src/config.ts` to resolve an optional story-point field id.
- Modify `packages/sdk/src/client.ts` with `getJiraSprintPoints`.
- Modify `packages/sdk/src/index.ts` to export the type and the default field constant.
- Modify `packages/sdk/tests/client.test.ts` with rollup tests.
- Modify `packages/cli/src/commands/jira-sprint.ts` for `--points` / `--points-field`.
- Modify `packages/mcp/src/tools/resources.ts` for `includePoints` / `pointsField`.
- Modify `packages/mcp/README.md` and the root `README.md`.

## Task 1: SDK

- [x] Add `JiraSprintPoints` (`field`, `committed`, `completed`, `issueCount`, `unestimated`) and
      `JiraSprintPointsOptions`.
- [x] Resolve the field id as option, then `ATLASSIAN_STORY_POINTS_FIELD`, then `customfield_10105`.
- [x] Implement `getJiraSprintPoints` requesting only the points field and `status`, summing
      committed and completed by `status.statusCategory.key === "done"`, rounded to two decimals.

## Task 2: SDK Tests

- [x] Rollup asserts the `fields` query, the committed/completed split, and the unestimated count.
- [x] Field id override asserted through both the option and the environment variable.

## Task 3: CLI

- [x] `sprint get --points [--points-field <id>]` adds a `points` object to JSON and point lines to
      text output.
- [x] `sprint close --points` computes the rollup before any rollover move and includes it in the
      dry-run preview and the closed result.

## Task 4: MCP

- [x] `jira_get_sprint` and `jira_close_sprint` take `includePoints` and `pointsField`.

## Task 5: Verification

- [x] `bun test` passes.
- [x] `bun run lint` passes.
- [x] `bun run dev:cli -- jira sprint get --help` prints the new flags.

## Assumptions & Decisions

- Opt-in rather than always-on, so `sprint get` stays a single request unless points are asked for.
- Points are computed before rollover in `sprint close` so `committed` describes the sprint as
  committed, not the remainder left after unfinished work moves out.
- "Done" is `status.statusCategory.key`, not a status name, so site-specific workflow names do not
  have to be configured.
