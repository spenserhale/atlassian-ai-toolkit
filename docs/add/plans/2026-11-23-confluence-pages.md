# Confluence Pages Implementation Plan

**Goal:** Build `confluence get` (with the body), `search`, `create`, and `edit` in the SDK, and
wire them into the CLI and MCP, as specified in
`docs/add/specs/2026-11-23-confluence-pages-design.md`.

**Architecture:** All API logic and conversion live in `packages/sdk`. ADF is the working format.
`adf-markdown.ts` reads ADF into markdown and records what is lossy. `confluence-edit.ts` holds the
pure tree operations. `client.ts` handles the HTTP flow, version checks, and conflict
classification. The CLI and MCP are thin wrappers that share one error serializer.

**Tech stack:** Bun, TypeScript, Zod, Stricli, FastMCP, Confluence Cloud REST v2, and v1 for
search and labels.

---

## Files

**Create:**

- `packages/sdk/src/adf-markdown.ts`
- `packages/sdk/src/confluence-edit.ts`
- `packages/sdk/tests/adf-markdown.test.ts`
- `packages/sdk/tests/confluence-edit.test.ts`
- `packages/sdk/tests/confluence-client.test.ts`
- `packages/cli/src/commands/confluence-search.ts`
- `packages/cli/src/commands/confluence-create.ts`
- `packages/cli/src/commands/confluence-edit.ts`
- `packages/cli/src/body.ts`, which reads `--body` or `--body-file`

**Modify:**

- `packages/sdk/src/adf.ts`: escapes, task lists, and tables
- `packages/sdk/src/types.ts`
- `packages/sdk/src/client.ts`
- `packages/sdk/src/index.ts`
- `packages/cli/src/commands/confluence-get.ts`
- `packages/cli/src/errors.ts`
- `packages/cli/src/app.ts`
- `packages/mcp/src/tools/resources.ts`
- `README.md`
- `packages/mcp/README.md`
- `CHANGELOG.md`
- the version files

## Task 1: Writer Additions (`adf.ts`)

- [x] Backslash escapes in inline text.
- [x] Task lists (`- [ ]` and `- [x]`), producing `taskList` / `taskItem` with a `localId`.
- [x] GitHub-style tables, producing `table` / `tableRow` / `tableHeader` / `tableCell` with a
      paragraph in each cell.
- [x] Existing ADF tests still pass. Add tests for each new construct.

## Task 2: Reader (`adf-markdown.ts`)

- [x] ADF → markdown for every supported construct, escaping text that markdown would
      reinterpret.
- [x] Placeholder tokens and markers, `lossy` counts, and dropped-formatting detection.
- [x] Outline with sizes and unique selectors. Section lookup by heading, path, or `[n]`, through
      layout columns.
- [x] Round-trip tests in both directions, plus the list regression.

## Task 3: Edit Operations (`confluence-edit.ts`)

- [x] `replaceSection`, `appendBlocks`, `prependBlocks`, and `findReplace` (match count, `--all`,
      marks taken from the first matched character).
- [x] `lossyIn(nodes)` for section and whole-body checks, and `containsPlaceholder(markdown)`.
- [x] Unit tests.

## Task 4: Client

- [x] `getConfluencePageContent`: body formats, draft, space key, url, lossy, outline, and
      sections.
- [x] `searchConfluence`: CQL or text, cursor, fields, and excerpt.
- [x] `createConfluencePage`: space resolution, parent and ancestors, duplicate-title check, dry
      run, labels, and error mapping.
- [x] `editConfluencePage`: version checks, the legacy gate, the draft warning, 409
      classification, the retry rule, title routing, and dry run.
- [x] Stubbed-fetch tests for each error code.

## Task 5: CLI

- [x] A shared error serializer (exit codes 1, 2, and 3, with details and hints).
- [x] Four commands with one-screen help and two examples each.
- [x] Text and JSON output as specified.

## Task 6: MCP

- [x] Extend `confluence_get_page`, and add `confluence_search`, `confluence_create_page`, and
      `confluence_edit_page`, with inline `body` and compact JSON output.

## Task 7: Docs And Release

- [x] Update the README, the MCP README, and the CHANGELOG `[0.11.0]` section.
- [x] Bump the version to 0.11.0 in the same files as the 0.10.0 release.
- [x] `bun run lint` and `bun test` pass.

## Task 8: Live Checks

- [ ] Reads, once credentials are set: the size guard, the search size, a legacy page, the editor
      property, and drafts.
- [ ] Writes only on a scratch page provided by the owner.
