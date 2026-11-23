# Confluence Page Read, Search, Create, and Edit Design

## Problem

Agent threads use the Atlassian Rovo MCP connector for Confluence because this toolkit can only get
page metadata (`confluence get` returns an empty `body`), delete a page, and upload an attachment.
The connector costs about 2,200 tokens at the start of every Claude thread and about 5,700 tokens of
tool schemas in each session that uses it. It does not exist on Codex, which runs about two thirds
of the threads. Its results also repeat links, titles, and dates, and it echoes the page body after
every write.

Usage across 58 sessions sets the defaults:

| Need | Observed | Default chosen here |
|---|---|---|
| Read | 39 calls, markdown 19 / HTML 9, median 2,800 chars, p90 22,900, max 49,200 | Markdown, size guard at 12,000 chars |
| Search | 26 calls, always CQL, limits 10–50, median 2,500 chars | `--cql`, limit 10, short excerpt |
| Update | 10 calls: 6 targeted edits, 4 whole-body replaces, all passing a concurrency token | Targeted edits by default; a whole-body replace requires `--expect-version` |
| Create | 8 calls, always with a parent | `--parent` takes the space from the parent |
| Format guide | 8 fetches | The supported markdown is listed in `--help` |

Three failures from connector use shape the design. A stale whole-body update overwrites other
people's edits. Markdown drops macros and images, and writing that markdown back deletes them.
Agents pay for a 49,000-character page when they need one section.

## Review History

Codex (GPT-6.2 Astra) and CodeRabbit reviewed the first draft on 2026-11-23. Their findings changed
the design as follows:

- Placeholders are for display only and no longer restore nodes.
- A 409 is split into `version_conflict` and `approval_required`.
- Title-only edits use the title endpoint only when no version check is asked for.
- Edits warn when an unpublished draft exists.
- ADF writes are refused on legacy-editor pages.
- Round-trip testing starts from Confluence-authored ADF.
- Sections can be selected by occurrence when a heading repeats.
- Errors keep the existing exit codes and details.
- The MCP edit tool takes an inline body.

## API Facts This Design Relies On

These were checked against Atlassian's published Confluence Cloud OpenAPI specs (v2 and v1) on
2026-11-23. Items marked *verify live* are not stated in the docs and get a live check (see
Testing) before release.

- **`GET /wiki/api/v2/pages/{id}`:**
  - Takes `body-format` (`storage`, `atlas_doc_format`, `view`, …), `get-draft`, and
    `include-version` (on by default).
  - Returns `id`, `status`, `title`, `spaceId`, `parentId`, `version.number`,
    `body.<format>.value` (ADF arrives as a JSON string), and `_links.webui` / `_links.base`.
  - What `get-draft=true` returns when no draft exists is *verify live*. Draft detection reads the
    returned `status`.
- **`POST /wiki/api/v2/pages`:**
  - Takes `spaceId`, `status` (`current` | `draft`), `title`, `parentId`, and
    `body: { representation, value }`, where the representation is `storage`, `atlas_doc_format`,
    or `wiki`.
  - Returns 200 on success. Returns 404 both when the space does not exist and when the caller
    lacks permission to create there.
  - The response to a duplicate title is *verify live*.
- **`PUT /wiki/api/v2/pages/{id}`:**
  - Requires `id`, `status`, `title`, `body`, and `version: { number, message }`. `number` must be
    the current version plus one.
  - **There is no `minorEdit` or notify-watchers control on v2 writes**, and the v1 page update
    endpoint is no longer in the spec.
  - The only 409 the docs describe is that **content approval is required** before publishing.
    The response to a stale version number is *verify live*.
  - Updating the current page **may overwrite an unpublished draft that has diverged
    substantially**.
- **`PUT /wiki/api/v2/pages/{id}/title`** takes `{ status, title }` only: no version number and no
  message.
- **`GET /wiki/api/v2/pages/{id}/ancestors`** lists ancestors root first, as `{ id, type }` only.
- **`GET /wiki/api/v2/spaces?keys=<KEY>`** resolves a space key to its id.
- **`GET /wiki/api/v2/pages/{id}/properties?key=editor`** reads the `editor` content property.
  `v2` marks a new-editor page. The property is a Confluence convention, not a documented contract:
  *verify live*.
- **`GET /wiki/rest/api/search`** (v1, CQL):
  - Takes `cql`, `limit`, `cursor`, `excerpt`, and `expand`.
  - Returns `results[]`, `totalSize`, and `_links.next`, a relative URL that carries the next
    `cursor`.
  - Excerpts carry `@@@hl@@@` / `@@@endhl@@@` highlight markers. This is not in the docs but is
    confirmed by Atlassian bug reports.
- **`POST /wiki/rest/api/content/{id}/label`** (v1) adds labels. v2 has no label write.
- There is no synchronous storage↔ADF conversion endpoint. Only an async convert job exists.

## Command Surface

All four commands share these conventions:

- **`--json` covers output and errors.** An error prints
  `{"status":"error","code":"<slug>","message":"...","details":...,"hint":...}` and exits:
  - 2 for a usage error;
  - 3 for a config error, the existing meaning;
  - 1 otherwise.

  One shared serializer in `packages/cli/src/errors.ts` replaces today's two paths
  (`handleError`, which keeps details, and `runCommand`, which keeps hints), so both details and
  hints survive.
- **Writes take `--dry-run`.**
- **Output:**
  - Page bodies are never echoed after a write, and there are no prompts.
  - Each page has at most one `url`: `_links.base + _links.webui`.
  - The default output is short `key: value` text, and `--json` returns the same facts as
    structured data.
- **`--help`** for each command fits on one screen (under 40 lines) and has two examples. Commands
  that take a body list the supported markdown.

### `confluence get <page-id>`

```text
atlassian confluence get <page-id> [--format markdown|storage|adf] [--outline | --section <sel>... | --meta | --full] [--draft] [--json]
```

- **Always printed:** `id`, `title`, `space` (key), `status`, `version`, `parent` (id), `url`, and
  `lossy` when the page has content markdown cannot express.
- **Size guard:** when the markdown body is over **12,000 characters**, the command prints the
  outline instead, with each section's size, plus one line:
  `body is 49,213 chars; use --section "<heading>" or --full`. 12,000 sits a little above half
  the observed p90 and about four times the median, so a typical read passes through untouched.
  `--full` turns the guard off.
- **`--outline`:** headings, section sizes, and each section's selector.
- **`--section <sel>`:** returns one section and can be repeated. A section is a heading and
  everything under it, up to the next heading of the same or a higher level. The selector is one
  of:
  - the heading text (case-insensitive exact match), as in `--section "Install"`;
  - a path, as in `--section "Setup > Install"`;
  - a path with an occurrence number when the path still repeats, as in
    `--section "Setup > Install [2]"`.

  Paths run through headings across the doc and inside layout columns. The selectors in the
  outline and in `section_ambiguous` errors are exact and unique, so an agent can copy one into
  `get` or `edit`.
- **`--meta`:** no body.
- **`--draft`:** reads the draft when one exists (`get-draft=true`).
- **`--format adf`:** the guard and `--section` / `--outline` apply, and sections come back as
  ADF node arrays.
- **`--format storage`:** always the whole raw storage XHTML. The toolkit does not parse storage
  format (see Conversion).

Default text output:

```text
id: 123456
title: Release Process
space: ENG
status: current
version: 14
parent: 123000
url: https://example.atlassian.net/wiki/spaces/ENG/pages/123456
lossy: macro x3 (toc, jira, code), image x2, underline x1
---
# Release Process
...
```

`--json`:
`{ id, title, space: { id, key }, status, version, parentId, url, format, body, lossy: [{ kind, count, detail? }], outline?, sections? }`.

### `confluence search`

```text
atlassian confluence search --cql "<CQL>" [--limit 10] [--cursor <c>] [--fields <list>] [--excerpt none|short|full] [--json]
atlassian confluence search --text "<words>" [--space <KEY>] [--type page] [...]
```

- **`--text`:** shorthand that builds `siteSearch ~ "<words>"`, plus `AND space = "<KEY>"` when
  `--space` is given and `AND type = <type>` (default `page`). It cannot be combined with
  `--cql`. Quotes and backslashes in the words are escaped.
- **Paging:** `--limit` defaults to 10. The envelope mirrors `jira search`:
  `{ results, count, total, isLast, nextCursor }`. `nextCursor` is lifted out of `_links.next`,
  and the text output ends with `more: --cursor <c>`.
- **Fields:** the default fields per hit are `id`, `title`, `space`, `type`, `modified` (ISO date),
  and `excerpt`. `--fields` replaces that set. The optional fields are `url`, `version`,
  `ancestors` (ids and titles, root first, from `expand=content.ancestors`), and `status`.
- **Excerpts:** highlight markers are removed (from titles too, where they also leak). `short`
  (the default) cuts to **90 characters** at a word boundary, `full` keeps Atlassian's excerpt,
  and `none` asks the API for no excerpt.
- **Text output:** the header line lists the space and type once when every hit shares them, and
  those columns are dropped from the hit lines:

```text
10 of 143 (space ENG, type page) more: --cursor eyJzdGFydCI6MTB9
123456  Release Process  2026-10-01
  Steps for cutting a release, tagging the build, and posting notes to the channel…
```

**Differs from the brief:** the brief asks for both a 160-character excerpt and ten hits in under
1,500 characters. Those two targets conflict: a 160-character excerpt alone is 1,600 characters
across ten hits. The default is therefore `short` = 90 characters, and both reviewers agreed with
that choice. The 1,500-character target holds for typical titles. Long titles or mixed spaces can
push past it, and nothing is cut to force it. A test renders ten hits with long titles, mixed
spaces, and a cursor, and records the size.

### `confluence create`

```text
atlassian confluence create --title <t> (--parent <page-id> | --space <key|id>) (--body-file <path> | --body <text>) [--format markdown|storage|adf] [--draft] [--label <l>]... [--dry-run] [--json]
```

- **Placement:**
  - With `--parent`, the space comes from the parent: one `GET` of the parent, which also
    confirms that it is visible.
  - With `--space`, the page goes under the space homepage, which is the API default.
- **`--format`:** markdown becomes ADF, `adf` passes through, and `storage` passes through as the
  storage representation. Markdown containing a `[[cf:` placeholder fails with
  `placeholder_in_body`.
- **Duplicate titles:** a CQL check (`space = KEY AND type = page AND title = "<t>"`) runs before
  the write, so a duplicate fails with `title_exists`. The check runs on dry runs too. Matching
  the message of a 400 is the fallback (*verify live*).
- **`--label`:** labels are added after the create with one v1 call. A label failure does not undo
  the page. The command exits 1 with `status: created_with_errors`, the new page's `id` and `url`,
  and `failedLabels`, so an agent never creates the page a second time.
- **`--dry-run`** prints the resolved space (key, id), the parent's title and ancestor chain
  (titles, root first), the title, the body format, and the body size. The ancestor titles come
  from the v2 ancestors call plus one `GET` per ancestor, capped at 10.
- **Output:** `id`, `title`, `version`, `status`, `url`.
- **Error codes:**
  - `title_exists`
  - `parent_not_found`: "parent page is missing or not visible to you", from a 404 on the parent
    `GET`.
  - `space_not_found`: the space key or id lookup returned nothing.
  - `permission_denied`: the space resolved, but the create returned 403 or 404.
  - `auth_error`: 401, kept as today.
  - `body_too_large`: 413.

### `confluence edit <page-id>`

```text
# targeted edits; the rest of the stored document is untouched
atlassian confluence edit <id> --replace-section <sel> (--body-file <path> | --body <text>)
atlassian confluence edit <id> --append|--prepend (--body-file <path> | --body <text>)
atlassian confluence edit <id> --find <text> --replace <text> [--all]
atlassian confluence edit <id> --title <t>
# whole-body replace
atlassian confluence edit <id> (--body-file <path> | --body <text>) --expect-version <n> [--allow-lossy]
# every form
  [--format markdown|adf|storage] [--expect-version <n>] [--message <m>] [--allow-lossy] [--dry-run] [--json]
```

**Combining operations.** Each call does exactly one body operation (`--replace-section`,
`--append`, `--prepend`, `--find`, or a whole-body replace). `--title` can be added to any of them,
or used alone.

**Targeted edits:**

- **How they work:** they read the page as ADF, change only the affected nodes, and write ADF back.
  Macros, images, and every other node outside the change keep their stored JSON exactly.
- **Body formats:** the body for a targeted edit is markdown or ADF. `--format storage` with a
  targeted flag fails as a usage error before any request.
- **`--replace-section <sel>`:** the heading stays, and everything under it up to the next heading
  of the same or a higher level is replaced. A section inside a layout column stays inside that
  column.
  - **Errors:** `section_not_found`, and `section_ambiguous`, which lists the exact selectors.
  - **Opaque content:** if the replaced range holds opaque content (a macro, image, or other
    placeholder kind) or dropped formatting, the edit refuses with `lossy_replace`, listing what
    would go. `--allow-lossy` overrides.
- **`--append` / `--prepend`:** add the blocks at the end or start of the document.
- **`--find` / `--replace`:**
  - Matches exact text, compared within one block's run of text, so a match can cross bold or
    italic boundaries but not a mention, a macro, or a block boundary.
  - The replacement takes the marks of the first matched character. Code blocks are searched too.
  - An empty `--find` is a usage error.
  - Zero matches is `no_match`, with or without `--all`.
  - More than one match without `--all` is `multiple_matches`, with the count.
  - The result always reports `matches: <n>`.

**Title changes:**

- **`--title` alone, with no `--expect-version` or `--message`,** uses `PUT /pages/{id}/title`, so
  the body is not re-sent.
- **`--title` with `--expect-version` or `--message`** goes through the versioned page PUT. That
  call carries the read ADF body back unchanged, which is the same fidelity as a targeted edit.
  The title endpoint cannot enforce either flag.

**Whole-body replace** (a body with no targeted flag):

- **It requires `--expect-version`.** Without it, the command fails with
  `expect_version_required`.
- **A version mismatch** fails with `version_conflict` and `details: { expected, current }`, and
  writes nothing.
- **When the body is markdown and the stored page holds anything markdown cannot carry**
  (placeholder kinds or dropped formatting), it refuses with `lossy_replace` and
  `details.lost: [{ kind, count }]`. `--allow-lossy` overrides.
- **A `[[cf:` placeholder in a markdown body** fails with `placeholder_in_body`, so a display
  placeholder is never written to the page as literal text. That applies to targeted edits too.
- **It never retries.**

**Concurrency and conflicts:**

- When `--expect-version` is given, it is checked against the version read before the write.
- Every write sends `version.number = read + 1`.
- **When a PUT fails with 409**, the page is re-read to classify the failure:
  - If the version moved past the one read, the failure is `version_conflict`.
  - If not, and the message names approval, it is `approval_required`. The details say that the
    change must be saved as a draft and approved in Confluence.
  - Otherwise it is `write_rejected`, with the upstream message. Only `version_conflict` is ever
    retried.
- **A targeted edit retries once on `version_conflict`,** only when all of these hold:
  - no `--expect-version` was given;
  - the operation is append, prepend, find and replace, or a title-only versioned change;
  - after re-reading, the operation still applies. For find and replace, the match count is still
    valid.
- **`--replace-section` never retries.** The concurrent edit may have touched that section, and
  re-applying by heading would erase it.
- A failure where the outcome of the write is unknown (a network error after sending) is never
  retried. It is reported as `write_outcome_unknown`, with a hint to re-read the version.

**Drafts:**

- Every edit, including a dry run, checks for an unpublished draft with
  `GET ...?get-draft=true`, reading the returned status.
- When a draft exists, output and JSON include
  `draft: exists (Confluence may overwrite it if it diverged)`.
- `--help` states that Confluence may overwrite a diverged draft when the published page is
  updated.

**Legacy-editor pages:**

- Before an ADF write, the `editor` property is read. When it is missing or not `v2`, ADF writes (targeted
  edits, markdown or ADF whole-body replace, and a versioned title change) refuse with
  `legacy_editor_page`.
- A whole-body replace with `--format storage` and a title-only rename still work.
- This gate holds until the scratch-page read–write–read checks pass (see Testing). The spec is
  then updated with the result.

**Other options:**

- `--message` sets `version.message`.
- `--dry-run` reports the operation, the selector or match count affected, the version that would
  be written, the body size before and after in markdown characters, any `lossy_replace` content,
  and the draft warning. It never prints the body.
- **Output:** `id`, `title`, `version` (new), `url`, plus `matches`, `section`, or `draft` when
  relevant.

**`--notify` is not offered on page writes**, which differs from the brief:

- Confluence v2 create and update request schemas have no minor-edit or notify-watchers control.
  The v1 page update that had one is gone from the spec.
- Both reviewers confirmed this against the schema.
- `--help` says so: "Confluence notifies watchers per its own defaults; the v2 API has no minor-edit
  switch."
- A scratch-page check records that site's behaviour only.

## Conversion Decision

**Work in ADF (`atlas_doc_format`). Read by converting ADF to markdown, and write by converting
markdown to ADF.** Writes go to new-editor pages only until the live checks pass.

| | Read from ADF | Read from storage XHTML |
|---|---|---|
| Parser | ADF is JSON and its node types are a closed set. The SDK already writes ADF from markdown, and that writer is tested. | An XHTML namespace dialect (`ac:`, `ri:`) that needs a tolerant XML parser and a second converter. |
| Targeted edits | Splice nodes in a JSON tree and keep every other node byte for byte. | Splice XML text. Find and replace has to work around tags and entities. |
| What it loses | Legacy-editor pages are converted to ADF by Confluence on read, and content without an ADF form comes back wrapped (*verify live*). Whether an ADF write to a legacy page keeps its macros and images is unverified, so those writes are gated. | Nothing on read, since storage is the source format. But storage→markdown loses the same constructs (macros, layouts, images), and writes would still need a markdown→storage converter. |

ADF wins because targeted edits are the main write path (6 of 10 observed) and the ADF writer
already exists. Storage remains available raw through `--format storage` on `get`, and as a write
format for create and whole-body replace, which is also the legacy-page escape hatch.

### Supported Markdown (Round Trip)

These constructs convert markdown → ADF → markdown to equivalent markdown, and `--help` lists them:

- Headings `#`–`######`, paragraphs, and line breaks inside a paragraph.
- `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, and `[text](url)`. Marks do not nest.
- Backslash escapes (`\*`, `\_`, `` \` ``, `\[`, `\~`, `\\`, `\|`, `\#`), so literal markdown
  characters survive. *New on the write side.*
- Bullet and ordered lists, nested, with a start number.
- Task lists: `- [ ] todo`, `- [x] done`. *New on the write side.*
- Fenced code blocks with a language, `> quotes`, and `---` rules.
- Tables in GitHub style: one header row, and cells holding inline content only. *New on the write
  side.*

The writer additions (escapes, task lists, and tables) go into `adf.ts`, so `jira create` and
`jira edit` gain them as well. The one behaviour change for Jira is that a backslash before a
markdown character is now an escape, as CommonMark specifies.

**Round trip starting from Confluence's side.**

- On read, text is escaped wherever markdown would reinterpret it. Plain text `**urgent**` reads as
  `\*\*urgent\*\*` and is written back as plain text, not bold.
- Tests run ADF → markdown → ADF and assert semantic equivalence for synthetic Confluence-shaped
  documents. Those documents include literal markdown syntax, linked bold text, task items, table
  attributes, and unknown marks and attributes.
- Generated ids (`localId`) are excluded from the comparison. Every other difference must be
  reported in `lossy`, or the test fails.

### Content Markdown Cannot Express

On read, content markdown cannot express is marked and counted.

**1. Opaque content: shown as a placeholder.** A visible token marks the spot. Tokens are for
display only and are never restored:

```text
[[cf:macro toc]]
[[cf:image diagram.png]]
Owner: [[cf:mention @Ada Lovelace]]
```

Panels, expands, layout columns, and macros with a body show their inner content as normal
markdown, between an opening and a closing marker, so a reader sees what is inside:

```text
[[cf:panel info]]
Deploys freeze at 16:00 Friday.
[[/cf:panel]]
```

| Kind | ADF nodes | Shown as |
|---|---|---|
| `macro` | `extension`, `inlineExtension` | token with the macro key |
| `macro` (with body) | `bodiedExtension` | markers around the content |
| `panel`, `expand` | `panel`, `expand`, `nestedExpand` | markers around the content, with the panel type or expand title |
| `layout` | `layoutSection` / `layoutColumn` | markers around each column |
| `image`, `file` | `mediaSingle`, `mediaGroup`, `mediaInline` | token with the file name when known |
| `mention`, `date`, `status` | inline nodes | token with display text |
| `table` | a table with merged cells or block content in cells | shown as a GitHub table with cell blocks joined by ` / `, and counted |
| `decision`, other | `decisionList` and any node type not listed | token with the node type |

**2. Dropped formatting.** These become plain markdown:

- underline, text colour, background colour, sub/superscript
- alignment and indentation
- code block width (`breakout`), and table width, column widths, cell colours, and header placement
- nested marks (for example, a bold link reads as a plain link)
- emoji, which become their Unicode character
- smart links (`inlineCard`), which become plain links

`lossy` reports both kinds with a count for each, for example
`macro x3 (toc, jira), image x2, underline x1`.

**When a write refuses.** A markdown write that would replace any of this content refuses with
`lossy_replace` unless `--allow-lossy` is given:

- a whole-body replace, when the stored page holds any of it;
- a section replace, when the replaced section holds any of it.

Targeted edits elsewhere on the page are unaffected, because they leave those nodes untouched.

**Considered and deferred: restorable placeholders.** Both reviews showed that depth-first node
numbers identify a position, not where a token came from. A token from another page or an older
read could resolve to the wrong node. A duplicated token could duplicate a macro's local id, and a
moved token could break the parent's schema. Safe restoring would need tokens bound to the page,
version, and node identity, plus placement validation. That is listed as a follow-up.

### Regression: Blocks After a List

An earlier writer nested every block that followed a list inside the list's last item (fixed in
0.10.0). A Confluence-path test writes a page body with a list followed by a paragraph and a bold
label line, then asserts the ADF puts them as top-level siblings and that the markdown read back
matches.

## SDK Surface

`packages/sdk`:

- `adf-markdown.ts`: `adfToMarkdown(nodes) → { markdown, lossy }`, plus outline and section
  helpers (`adfOutline`, `findAdfSection`) that work on node lists in the doc and in layout
  columns, and that produce the unique selectors.
- `adf.ts`: `markdownToAdf` gains backslash escapes, task lists, and tables.
- `confluence-edit.ts`: pure operations (`replaceSection`, `appendBlocks`, `prependBlocks`,
  `findReplace`, `lossyIn`), unit-testable without HTTP.
- `client.ts`:
  - `getConfluencePageContent(id, { format, draft })`
  - `searchConfluence({ cql | text, space, type, limit, cursor, fields, excerpt })`
  - `createConfluencePage(input, { dryRun })`
  - `editConfluencePage(id, edit, { dryRun, expectVersion, allowLossy, message })`
  - private helpers to resolve the space, read ancestors, read the editor property, and check for
    a draft
- New error codes on `AtlassianFieldError`:
  - create: `title_exists`, `parent_not_found`, `space_not_found`, `permission_denied`,
    `body_too_large`, `placeholder_in_body`
  - edit concurrency: `version_conflict`, `approval_required`, `write_rejected`,
    `write_outcome_unknown`, `expect_version_required`
  - edit content: `lossy_replace`, `legacy_editor_page`
  - sections and matches: `section_not_found`, `section_ambiguous`, `no_match`,
    `multiple_matches`
  - search: `invalid_cql`

**MCP:** `confluence_get_page` gains the read options, and three tools are added:
`confluence_search`, `confluence_create_page`, and `confluence_edit_page`.

- They take the same inputs as the CLI.
- Bodies are passed inline as `body` (with `format`), since an MCP server may not share the agent's
  filesystem.
- They return the same JSON as `--json`, compact rather than indented, to save tokens.

## Safety

- Creating and editing are reversible through page history, so no `--force --confirm` gate
  applies, matching `jira edit`. `--dry-run` previews both.
- The real risks are guarded instead:
  - **silent overwrite:** the version expectation, conflict classification, and no retry for
    section replaces;
  - **silent content loss:** `lossy_replace` and `placeholder_in_body`;
  - **draft loss:** a warning;
  - **legacy-page conversion:** `legacy_editor_page`.
- Delete stays as it is.
- Tests use synthetic pages only, and no test touches the keychain.
- Live writes happen only on a scratch page the user provides.

## Testing

Unit tests, with `fetch` stubbed and synthetic fixtures:

- **Conversion:**
  - a markdown → ADF → markdown round trip for every supported construct;
  - an ADF → markdown → ADF semantic round trip for Confluence-shaped documents (literal markdown
    characters, linked bold, task items, table attributes, unknown marks);
  - placeholder and marker rendering;
  - `lossy` counts;
  - the list-then-paragraph regression on the Confluence path.
- **Outline and sections:** nested headings, sections inside layout columns, a missing heading,
  duplicate headings, duplicate paths that need `[n]`, and selectors in the outline and errors
  that resolve back to the same section.
- **Find and replace:** zero, one, and many matches; `--all` with zero matches; an empty `--find`;
  a match across bold boundaries.
- **Edit flow:**
  - a version mismatch before the write;
  - a 409 classified as `version_conflict`, `approval_required`, and `write_rejected`;
  - the targeted retry once;
  - no retry for a section replace or a whole-body replace;
  - `lossy_replace` for a whole body and for a section, and `--allow-lossy`;
  - `placeholder_in_body`, `legacy_editor_page`, and the draft warning;
  - title-only through `/title`, and title with `--expect-version` through the page PUT.
- **Search:** CQL from `--text` with escaping, cursor extraction, `isLast`, field selection,
  excerpt cleaning and cutting, and the full rendered size with long titles and mixed spaces.
- **Create:** payloads for each format, space from the parent, the duplicate-title check, each
  error code, and labels with a label failure (`created_with_errors`).
- **CLI:** the error serializer keeps exit 3 for config errors and keeps both details and hints.

Live checks:

- **Reads**, once credentials are configured:
  - the size guard on a large page;
  - a ten-hit search under 1,500 characters;
  - an ADF read of a legacy-editor page;
  - the `editor` property on both kinds of page;
  - `get-draft` with and without a draft.
- **Writes on the scratch page only:**
  - the stale-version response;
  - title-only versioning;
  - the duplicate-title response;
  - watcher behaviour;
  - draft reconciliation;
  - an ADF GET–PUT–GET on a page with a macro, an image, and a table, checking that the ADF,
    storage, and editor property are unchanged apart from the edit.

## Release

The version bumps to 0.11.0 across `packages/*/package.json`, `packages/cli/src/version.ts`, and
`packages/mcp/src/index.ts`, with a CHANGELOG `[0.11.0]` section, as in the 0.10.0 release commit.

## Follow-ups (Out of Scope)

- Page comments.
- Labels beyond `--label` on create.
- Space lookup as a command.
- Ancestors as a command of its own.
- The attachment `fileId` needed to embed an uploaded image.
- An `agent-context` command.
- Jira comments. Jira transitions are already in PR #1.
- Restorable placeholders, bound to page, version, and node identity, with placement validation.
- `--notify` on page writes, if Atlassian adds a v2 control.
- ADF writes to legacy-editor pages, once the live checks pass.
- Editing drafts (`edit` targets the current version). `get --draft` and `create --draft` are in
  scope.
- Sections and the size guard for `--format storage`.
