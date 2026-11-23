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

## API Facts This Design Relies On

These were checked against Atlassian's published Confluence Cloud OpenAPI specs (v2 and v1) on
2026-11-23. Items marked *verify live* are not stated in the docs and get a live check before
release.

- `GET /wiki/api/v2/pages/{id}` takes `body-format` (`storage`, `atlas_doc_format`, `view`, …),
  `get-draft`, and `include-version` (on by default). It returns `id`, `status`, `title`,
  `spaceId`, `parentId`, `version.number`, `body.<format>.value` (ADF arrives as a JSON string),
  and `_links.webui` / `_links.base`.
- `POST /wiki/api/v2/pages` takes `spaceId`, `status` (`current` | `draft`), `title`, `parentId`,
  and `body: { representation, value }`, where the representation is `storage`,
  `atlas_doc_format`, or `wiki`. It returns 200. It returns 404 both when the space does not exist
  and when the caller lacks permission to create there.
- `PUT /wiki/api/v2/pages/{id}` requires `id`, `status`, `title`, `body`, and
  `version: { number, message }`. `number` must be the current version plus one. **v2 has no
  `minorEdit` or notify-watchers control on writes**, and the v1 page update endpoint is no longer
  in the spec. The status code for a stale version number is undocumented (*verify live*).
- `PUT /wiki/api/v2/pages/{id}/title` takes `{ status, title }` and changes the title alone.
- `GET /wiki/api/v2/pages/{id}/ancestors` lists ancestors root first, as `{ id, type }` only.
- `GET /wiki/api/v2/spaces?keys=<KEY>` resolves a space key to its id.
- `GET /wiki/rest/api/search` (v1, CQL) takes `cql`, `limit`, `cursor`, `excerpt`, and `expand`.
  It returns `results[]`, `totalSize`, and `_links.next`, a relative URL that carries the next
  `cursor`. Excerpts carry `@@@hl@@@` / `@@@endhl@@@` highlight markers. This is not in the docs but
  is confirmed by Atlassian bug reports.
- `POST /wiki/rest/api/content/{id}/label` (v1) adds labels. v2 has no label write.
- There is no synchronous storage↔ADF conversion endpoint. Only an async convert job exists.

## Command Surface

All four commands share these conventions:

- `--json` works for output and for errors. An error prints
  `{"status":"error","code":"<slug>","message":"...","details":...}` and exits non-zero: 2 for a
  usage error, 1 otherwise.
- Writes take `--dry-run`.
- There are no prompts, page bodies are never echoed after a write, and each page has at most one
  `url`: `_links.base + _links.webui`.
- The default output is short `key: value` text. `--json` returns the same facts as structured
  data.

### `confluence get <page-id>`

```text
atlassian confluence get <page-id> [--format markdown|storage|adf] [--outline | --section <heading>... | --meta | --full] [--draft] [--json]
```

- **Always printed:** `id`, `title`, `space` (key), `status`, `version`, `parent` (id), `url`, and
  `lossy` when the page has content markdown cannot express.
- **Size guard:** when the markdown body is over **12,000 characters**, the command prints the
  outline instead, with each section's size, plus one line:
  `body is 49,213 chars; use --section "<heading>" or --full`. 12,000 sits a little above half
  the observed p90 and about four times the median, so a typical read passes through untouched.
  `--full` turns the guard off.
- **`--outline`:** headings and section sizes only.
- **`--section`:** returns one section and can be repeated. A section is a heading and everything
  under it, up to the next heading of the same or a higher level. A heading that occurs twice can
  be named by its path, as in `--section "Setup > Install"`.
- **`--meta`:** no body.
- **`--draft`:** reads the draft when one exists (`get-draft=true`).
- **`--format adf`:** the guard and `--section` / `--outline` apply, and sections come back as
  ADF node arrays.
- **`--format storage`:** always the whole raw storage XHTML. Sections and the guard are not
  offered for storage, because the toolkit does not parse it (see Conversion).

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
  `--cql`. Quotes in the words are escaped.
- **Paging:** `--limit` defaults to 10. The envelope mirrors `jira search`:
  `{ results, count, total, isLast, nextCursor }`. `nextCursor` is lifted out of `_links.next`, and
  the text output ends with `more: --cursor <c>`.
- **Fields:** the default fields per hit are `id`, `title`, `space`, `type`, `modified` (ISO date),
  and `excerpt`. `--fields` replaces that set. The optional fields are `url`, `version`,
  `ancestors` (ids and titles, root first, from `expand=content.ancestors`), `status`, and `labels`.
- **Excerpts:** highlight markers are removed. `short` (the default) cuts to **90 characters** at
  a word boundary, `full` keeps Atlassian's excerpt, and `none` asks the API for no excerpt.
- **Text output:** the header line lists the space and type once when every hit shares them, and
  those columns are dropped from the hit lines:

```text
10 of 143 (space ENG, type page) more: --cursor eyJzdGFydCI6MTB9
123456  Release Process  2026-10-01
  Steps for cutting a release, tagging the build, and posting notes to the channel…
```

**Differs from the brief:** the brief asks for both a 160-character excerpt and ten hits in under
1,500 characters. Those two targets conflict: a 160-character excerpt alone is 1,600 characters
across ten hits. The default is therefore `short` = 90 characters, which keeps ten typical hits
near 1,400 characters, and `--excerpt full` gives the longer form. Review this number.

### `confluence create`

```text
atlassian confluence create --title <t> (--parent <page-id> | --space <key|id>) (--body-file <path> | --body <text>) [--format markdown|storage|adf] [--draft] [--label <l>]... [--dry-run] [--json]
```

- **Placement:**
  - With `--parent`, the space comes from the parent: one `GET` of the parent, which also
    confirms that it exists.
  - With `--space`, the page goes under the space homepage, which is the API default.
- **`--format`:** markdown becomes ADF, `adf` passes through, and `storage` passes through as the
  storage representation.
- **Duplicate titles:** a CQL check (`space = KEY AND type = page AND title = "<t>"`) runs before
  the write, so a duplicate fails with `title_exists`. That check runs on dry runs too. Jira-style
  message matching on a 400 is the fallback (*verify live*).
- **`--label`:** labels are added after the create with one v1 call. A label failure does not undo
  the page. The result reports `status: created` with a `labelErrors` entry and exits 1.
- **`--dry-run`** prints the resolved space (key, id), the parent's title and ancestor chain
  (titles, root first), the title, the body format, and the body size. The ancestor titles come
  from the v2 ancestors call plus one `GET` per ancestor, capped at 10.
- **Output:** `id`, `title`, `version`, `status`, `url`.
- **Error codes:**
  - `title_exists`
  - `parent_not_found`: the parent `GET` returned 404.
  - `space_not_found`: the space key lookup returned nothing.
  - `permission_denied`: the space resolved, but the create returned 401, 403, or 404.
  - `body_too_large`: 413.

### `confluence edit <page-id>`

```text
# targeted edits; the rest of the stored document is untouched
atlassian confluence edit <id> --replace-section <heading> --body-file <path>
atlassian confluence edit <id> --append|--prepend --body-file <path>
atlassian confluence edit <id> --find <text> --replace <text> [--all]
atlassian confluence edit <id> --title <t>
# whole-body replace
atlassian confluence edit <id> --body-file <path> --expect-version <n> [--allow-lossy]
# every form
  [--format markdown|adf|storage] [--expect-version <n>] [--message <m>] [--dry-run] [--json]
```

- **Combining:** exactly one body operation per call (`--replace-section`, `--append`,
  `--prepend`, `--find`, or a whole-body replace). `--title` can be added to any of them, or used
  alone.
- **Targeted edits** read the page as ADF, change only the affected nodes, and write ADF back.
  Macros, images, and every other node outside the change keep their stored JSON exactly. The
  body file for a targeted edit is markdown or ADF. Storage format is accepted only for a
  whole-body replace, because splicing it would require parsing storage format.
- **`--replace-section`:** the heading stays, and everything under it up to the next heading of
  the same or a higher level is replaced. A section can live inside a layout column, and
  replacement stays inside that column.
  - Error codes: `section_not_found`, and `section_ambiguous`, which lists each occurrence's path
    so the caller can retry with `"Parent > Child"`.
- **`--append` / `--prepend`:** add the blocks at the end or start of the document.
- **`--find` / `--replace`:** matches exact text, compared within one block's run of text, so a
  match can cross bold or italic boundaries but not a mention, a macro, or a block boundary. The
  replacement takes the marks of the first matched character. Code blocks are searched too.
  - It fails with `no_match` (count 0) or `multiple_matches` (with the count) unless `--all` is
    given. The result always reports `matches: <n>`.
- **`--title`** alone uses `PUT /pages/{id}/title`, so the body is not re-sent.
- **Whole-body replace** (`--body-file` with no targeted flag):
  - It requires `--expect-version`. Without it, the command fails with `expect_version_required`.
  - When the current version differs, it fails with `version_conflict` and
    `details: { expected, current }`, and writes nothing.
  - When the body is markdown and the stored page holds content the markdown would drop, it
    refuses with `lossy_replace` and `details.lost: [{ kind, count }]`. `--allow-lossy` overrides.
    Content kept through placeholders (see Conversion) does not count as lost.
  - It never retries.
- **Concurrency:**
  - When `--expect-version` is given, it is checked against the version read before the write.
  - Every write sends `version.number = read + 1`. If someone writes in between, the PUT is
    rejected, and that rejection is treated as `version_conflict`.
  - A targeted edit re-reads, re-applies, and retries once on a conflict, unless
    `--expect-version` was given. An explicit expectation is a promise about what the caller saw,
    so a retry would break it.
  - A whole-body replace never retries.
- **`--message`** sets `version.message`.
- **`--dry-run`** reports the operation, the sections or match count affected, the version that
  would be written, and the body size before and after, in markdown characters. It never prints
  the body.
- **Output:** `id`, `title`, `version` (new), `url`, plus `matches` or `section` when relevant.

**Differs from the brief: `--notify` is not offered on page writes.** Confluence v2 has no
minor-edit or notify-watchers control on create or update. `minorEdit` exists only on the version
object a response returns, and the v1 page update that had it is gone from the spec. Offering a
flag the API cannot honour would mislead the caller. Watchers get Confluence's default behaviour,
which a live check against a scratch page will confirm. If Atlassian adds the control, the flag is
a small follow-up.

## Conversion Decision

**Work in ADF (`atlas_doc_format`). Read by converting ADF to markdown, and write by converting
markdown to ADF.**

| | Read from ADF | Read from storage XHTML |
|---|---|---|
| Parser | ADF is JSON and its node types are a closed set. The SDK already writes ADF from markdown, and that writer is tested. | An XHTML namespace dialect (`ac:`, `ri:`) that needs a tolerant XML parser and a second converter. |
| Targeted edits | Splice nodes in a JSON tree and keep every other node byte for byte. | Splice XML text. Find and replace has to work around tags and entities. |
| Placeholders | A node index addresses the original JSON node exactly, which makes restoring it on write possible (below). | Would need XPath-like addressing into reparsed XML. |
| What it loses | Legacy-editor pages are converted to ADF by Confluence on read, and content without an ADF form comes back wrapped (*verify live*). Writing ADF converts a legacy page to the new editor, which is what an edit in the UI does too. | Nothing on read, since storage is the source format. But storage→markdown loses the same constructs (macros, layouts, images), and writes would still need a markdown→storage converter. |

ADF wins because targeted edits are the main write path (6 of 10 observed) and the ADF writer
already exists. Storage remains available raw through `--format storage` on `get`, and as a write
format for create and whole-body replace.

### Supported Markdown (Round Trip)

These constructs convert markdown → ADF → markdown to equivalent markdown, and `--help` lists them:

- Headings `#`–`######`, paragraphs, and line breaks inside a paragraph.
- `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, and `[text](url)`. Marks do not nest.
- Bullet and ordered lists, nested, with a start number.
- Task lists: `- [ ] todo`, `- [x] done`. *New on the write side.*
- Fenced code blocks with a language, `> quotes`, and `---` rules.
- Tables in GitHub style: one header row, and cells holding inline content only. *New on the write
  side.*

Two writer additions (task lists and tables) go into `adf.ts`, so `jira create` and `jira edit`
gain them as well.

### Content Markdown Cannot Express

Content markdown cannot express falls into two kinds.

**1. Kept through placeholders.** A visible token holds the place of an ADF node the converter does
not render:

```text
[[cf:7 macro toc]]
[[cf:12 image diagram.png]]
Owner: [[cf:15 mention @Ada Lovelace]]
```

`N` is the node's position in a depth-first walk of the page. When markdown that still contains
`[[cf:N ...]]` is written back, the original node with that number is restored from the page that
was read, byte for byte. A whole-body replace requires `--expect-version`, so the page that was
read is the page being replaced, and the numbers line up. A number the read page does not have
fails with `unknown_placeholder`.

Containers whose inner content is ordinary markdown use a paired form, so the content stays
readable and editable while the wrapper keeps its stored attributes:

```text
[[cf:20 panel info]]
Deploys freeze at 16:00 Friday.
[[/cf:20]]
```

| Kind | ADF nodes | Form |
|---|---|---|
| `macro` | `extension`, `inlineExtension` | leaf |
| `macro` (with body) | `bodiedExtension` | paired |
| `panel`, `expand` | `panel`, `expand`, `nestedExpand` | paired, with the panel type or expand title |
| `layout` | `layoutSection` / `layoutColumn` | paired per column |
| `image`, `file` | `mediaSingle`, `mediaGroup`, `mediaInline` | leaf, with the file name when known |
| `mention`, `date`, `status` | inline nodes | leaf, with display text |
| `table` | a table with merged cells or block content in cells | leaf |
| `decision`, other | `decisionList` and any node type not listed | leaf |

**2. Dropped formatting.** These become plain markdown and cannot come back:

- underline, text colour, background colour, sub/superscript
- alignment and indentation
- code block width (`breakout`)
- emoji, which become their Unicode character
- smart links (`inlineCard`), which become plain links

`lossy` reports both kinds with a count for each, for example
`macro x3 (toc, jira), image x2, underline x1`. JSON also carries
`dropped: true|false` for each kind.

A whole-body markdown replace is lossy when either of these holds:

- the stored page has any kind 2 formatting, or
- a kind 1 placeholder from the read page is missing from the new markdown.

Either case refuses with `lossy_replace` unless `--allow-lossy` is given. A targeted edit only
replaces the nodes it touches, so a lossy page elsewhere does not block it. If the replaced
section itself contains kind 2 formatting, it is reported in the dry run and in the result.

### Regression: Blocks After a List

An earlier writer nested every block that followed a list inside the list's last item (fixed in
0.10.0). A Confluence-path test writes a page body with a list followed by a paragraph and a bold
label line, then asserts the ADF puts them as top-level siblings and that the markdown read back
matches.

## SDK Surface

`packages/sdk`:

- `adf-markdown.ts`: `adfToMarkdown(doc) → { markdown, lossy, placeholders }`, plus outline and
  section helpers (`adfOutline`, `findAdfSection`) that work on node lists inside `doc` and inside
  layout columns.
- `adf.ts`: `markdownToAdf` gains task lists, tables, and placeholder restoration through an
  optional `placeholders` map.
- `confluence-edit.ts`: pure operations (`replaceSection`, `appendBlocks`, `findReplace`,
  `checkLossyReplace`), unit-testable without HTTP.
- `client.ts`:
  - `getConfluencePageContent(id, { format, draft })`
  - `searchConfluence({ cql | text, space, type, limit, cursor, fields, excerpt })`
  - `createConfluencePage(input, { dryRun })`
  - `editConfluencePage(id, edit, { dryRun, expectVersion, allowLossy })`
  - `getConfluenceAncestors`
  - `resolveConfluenceSpace`
- New `AtlassianFieldError` codes: `title_exists`, `parent_not_found`, `space_not_found`,
  `permission_denied`, `body_too_large`, `version_conflict`, `expect_version_required`,
  `lossy_replace`, `section_not_found`, `section_ambiguous`, `no_match`, `multiple_matches`,
  `unknown_placeholder`, and `invalid_cql`.

**MCP:** `confluence_get_page` gains the read options, and three tools are added:
`confluence_search`, `confluence_create_page`, and `confluence_edit_page`. They take the same
inputs as the CLI and return the same JSON as `--json`, compact rather than indented, to save
tokens.

## Safety

- Creating and editing are reversible through page history, so no `--force --confirm` gate
  applies, matching `jira edit`. `--dry-run` previews both.
- The two irreversible risks are guarded instead:
  - silent overwrite, by the version expectation and the conflict check;
  - silent content loss, by the placeholders and `lossy_replace`.
- Delete stays as it is.
- Tests use synthetic pages only, and no test touches the keychain.
- Live writes happen only on a scratch page the user provides.

## Testing

Unit tests, with `fetch` stubbed and synthetic fixtures:

- **Conversion:** a round trip for every supported construct; placeholder emit and restore (leaf
  and paired); kind 2 detection; the list-then-paragraph regression on the Confluence path.
- **Outline and sections:** nested headings, sections inside layout columns, a missing heading,
  a duplicate heading, and path disambiguation.
- **Find and replace:** zero, one, and many matches; `--all`; a match across bold boundaries.
- **Edit flow:** a version conflict before the write and at the PUT, the targeted retry once, a
  whole-body replace never retrying, `lossy_replace`, `--allow-lossy`, and `unknown_placeholder`.
- **Search:** CQL from `--text`, cursor extraction, `isLast`, field selection, excerpt cleaning
  and cutting.
- **Create:** payloads for each format, space from the parent, the duplicate-title check, each
  error code, and labels with a label failure.

Live checks (reads only until a scratch page is given):

- the size guard on a large page;
- a ten-hit search under 1,500 characters;
- ADF reads of a legacy-editor page;
- then, on the scratch page: the stale-version status code, title-only versioning, the duplicate
  title error, and watcher behaviour.

## Release

The version bumps to 0.11.0 across `packages/*/package.json`, `packages/cli/src/version.ts`, and
`packages/mcp/src/index.ts`, with a CHANGELOG `[0.11.0]` section, as in the 0.10.0 release
commit.

## Follow-ups (Out of Scope)

- Page comments.
- Labels beyond `--label` on create.
- Space lookup as a command.
- Ancestors as a command of its own.
- The attachment `fileId` needed to embed an uploaded image.
- An `agent-context` command.
- Jira comments. Jira transitions are already in PR #1.
- `--notify` on page writes, if Atlassian adds a v2 control.
- Editing drafts (`edit` targets the current version). `get --draft` and `create --draft` are in
  scope.
- Sections and the size guard for `--format storage`.
