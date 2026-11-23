/**
 * Markdown to Atlassian Document Format.
 *
 * Jira's v3 API rejects a plain string for rich-text fields (`description`, `environment`, textarea
 * custom fields), and callers write markdown, so the conversion belongs in the SDK rather than in
 * every consumer. Coverage is the markdown an issue description or a Confluence page actually uses:
 * headings, lists, task lists, tables, code blocks, quotes, rules, inline emphasis, code, links, and
 * backslash escapes. Anything unrecognised stays literal paragraph text rather than being dropped.
 */

export interface AdfNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AdfDocument {
  readonly type: "doc";
  readonly version: 1;
  readonly content: readonly AdfNode[];
}

interface AdfMark {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
}

const FENCE = /^(\s*)```+\s*(\S*)[^\n]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** ASCII punctuation, which a backslash makes literal, as CommonMark specifies. */
const ESCAPABLE = /\\([!-/:-@[-`{-~])/g;

/**
 * One pass of the inline grammar: backslash escape, code, link, strong, strike, emphasis. The
 * emphasis alternatives carry CommonMark's flanking rules, so `user_id_field` and `2 * 3 * 4` stay
 * literal text, and a link href may hold one level of balanced parentheses, as Wikipedia URLs do.
 * Mark contents may hold escaped characters, so `**a\*b**` is bold `a*b`.
 */
const INLINE = new RegExp(
  [
    String.raw`\\(?<esc>[!-/:-@[-` + "`" + String.raw`{-~])`,
    String.raw`(?<!` + "`" + String.raw`)(?<tick>` + "`" + String.raw`+)(?<code>(?:(?!\k<tick>)[^\n])+?)\k<tick>(?!` + "`" + ")",
    String.raw`\[(?<ltext>(?:\\.|[^\]\\])*)\]\((?<href>(?:[^()\s]|\([^()\s]*\))+)\)`,
    String.raw`\*\*(?<s1>(?:\\.|[^*\\])+)\*\*`,
    String.raw`(?<![A-Za-z0-9_])__(?<s2>(?:\\.|[^_\\])+)__(?![A-Za-z0-9_])`,
    String.raw`~~(?<st>(?:\\.|[^~\\])+)~~`,
    String.raw`\*(?<e1>(?:\\.|[^*\\\s])(?:(?:\\.|[^*\\\n])*?(?:\\.|[^*\\\s]))?)\*`,
    String.raw`(?<![A-Za-z0-9_])_(?<e2>(?:\\.|[^_\\\s])(?:(?:\\.|[^_\\\n])*?(?:\\.|[^_\\\s]))?)_(?![A-Za-z0-9_])`,
  ].join("|")
);

/** Removes backslash escapes from text that is taken literally, such as a mark's content. */
export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPABLE, "$1");
}

function textNode(text: string, marks?: readonly AdfMark[]): AdfNode {
  return marks === undefined || marks.length === 0 ? { type: "text", text } : { type: "text", text, marks };
}

/** Adjacent plain text pieces (split by escapes) become one text node. */
function pushText(nodes: AdfNode[], text: string): void {
  if (text.length === 0) return;
  const last = nodes[nodes.length - 1];
  if (last !== undefined && last.type === "text" && last.marks === undefined) {
    nodes[nodes.length - 1] = textNode(`${String(last.text)}${text}`);
    return;
  }
  nodes.push(textNode(text));
}

/** CommonMark strips one space from each side of a code span when both sides have one. */
function codeSpanText(raw: string): string {
  return raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim().length > 0 ? raw.slice(1, -1) : raw;
}

/**
 * Marks do not nest here: the content of a bold or link span is taken literally, since a Jira
 * description rarely needs `**bold `code`**` and a partial parse would be worse than a plain one.
 */
function parseInline(input: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let rest = input;

  for (;;) {
    const match = INLINE.exec(rest);
    const raw = match?.[0];
    if (match === null || raw === undefined || raw.length === 0) break;

    if (match.index > 0) pushText(nodes, rest.slice(0, match.index));

    const groups = match.groups ?? {};
    const strong = groups.s1 ?? groups.s2;
    const emphasis = groups.e1 ?? groups.e2;

    if (groups.esc !== undefined) pushText(nodes, groups.esc);
    else if (groups.code !== undefined) nodes.push(textNode(codeSpanText(groups.code), [{ type: "code" }]));
    else if (groups.href !== undefined) {
      const linkText = groups.ltext !== undefined && groups.ltext.length > 0 ? unescapeMarkdown(groups.ltext) : groups.href;
      nodes.push(textNode(linkText, [{ type: "link", attrs: { href: groups.href } }]));
    } else if (strong !== undefined) nodes.push(textNode(unescapeMarkdown(strong), [{ type: "strong" }]));
    else if (groups.st !== undefined) nodes.push(textNode(unescapeMarkdown(groups.st), [{ type: "strike" }]));
    else if (emphasis !== undefined) nodes.push(textNode(unescapeMarkdown(emphasis), [{ type: "em" }]));

    rest = rest.slice(match.index + raw.length);
  }

  pushText(nodes, rest);
  return nodes;
}

/** ADF rejects an empty text node, so a paragraph with nothing in it carries no content at all. */
function paragraph(lines: readonly string[]): AdfNode {
  const content: AdfNode[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...parseInline(line));
  }
  return content.length === 0 ? { type: "paragraph", content: [] } : { type: "paragraph", content };
}

/**
 * ADF requires at least one block inside a list item or a blockquote, so a marker-only line like
 * `- ` gets an empty paragraph rather than producing a document Jira rejects.
 */
function withBlock(content: AdfNode[]): AdfNode[] {
  return content.length > 0 ? content : [{ type: "paragraph", content: [] }];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function startsBlock(line: string): boolean {
  return (
    line.trim().length === 0 ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

function dedent(line: string, columns: number): string {
  let cut = 0;
  while (cut < columns && line[cut] === " ") cut += 1;
  return line.slice(cut);
}

interface ListItems {
  readonly items: string[][];
  readonly next: number;
  readonly start: number;
}

/**
 * Collects the lines of one list, keeping each item's continuation and nested lines together so the
 * item body can be parsed as blocks of its own.
 */
function collectListItems(lines: readonly string[], from: number, ordered: boolean): ListItems {
  const marker = ordered ? ORDERED : BULLET;
  const first = marker.exec(lines[from] ?? "");
  const base = first === null ? 0 : (first[1] ?? "").length;
  const start = ordered ? Number(first?.[2] ?? 1) : 1;

  const items: string[][] = [];
  let index = from;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const match = marker.exec(line);

    if (match !== null && (match[1] ?? "").length === base) {
      items.push([ordered ? match[3] ?? "" : match[2] ?? ""]);
      index += 1;
      continue;
    }
    if (items.length === 0) break;

    if (line.trim().length === 0) {
      // A blank line ends the list unless the next content line still belongs to it.
      let lookahead = index + 1;
      while (lookahead < lines.length && (lines[lookahead] ?? "").trim().length === 0) lookahead += 1;
      const nextLine = lines[lookahead] ?? "";
      // Only a real marker at this indent continues the list; a plain line at the same indent is a new paragraph.
      const nextMarker = marker.exec(nextLine);
      const continues =
        lookahead < lines.length && (indentOf(nextLine) > base || (nextMarker !== null && (nextMarker[1] ?? "").length === base));
      if (!continues) break;
      items[items.length - 1]?.push("");
      index = lookahead;
      continue;
    }

    if (indentOf(line) > base) {
      items[items.length - 1]?.push(dedent(line, base + 2));
      index += 1;
      continue;
    }
    // A differently-marked line at the same indent starts a new block instead of continuing this one.
    if (startsBlock(line)) break;
    items[items.length - 1]?.push(line.trim());
    index += 1;
  }

  return { items, next: index, start };
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK_MARKER = /^\[([ xX])\](?:\s+(.*))?$/;

/** Splits a table row on unescaped pipes, dropping the optional outer pipes. */
function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** A GitHub-style table starts with a row holding a pipe, followed by a delimiter row. */
function startsTable(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1];
  return line.includes("|") && next !== undefined && next.includes("-") && TABLE_DELIMITER.test(next) && (next.includes("|") || line.trim().startsWith("|"));
}

function tableCell(type: "tableHeader" | "tableCell", text: string): AdfNode {
  const content = parseInline(text);
  return { type, attrs: {}, content: [content.length > 0 ? { type: "paragraph", content } : { type: "paragraph", content: [] }] };
}

function parseTable(lines: readonly string[], from: number): { node: AdfNode; next: number } {
  const header = splitTableRow(lines[from] ?? "");
  const width = header.length;
  const rows: AdfNode[] = [{ type: "tableRow", content: header.map((cell) => tableCell("tableHeader", cell)) }];
  let index = from + 2;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || !line.includes("|")) break;
    const cells = splitTableRow(line);
    const padded = Array.from({ length: width }, (_, column) => cells[column] ?? "");
    rows.push({ type: "tableRow", content: padded.map((cell) => tableCell("tableCell", cell)) });
    index += 1;
  }
  return { node: { type: "table", content: rows }, next: index };
}

function localId(): string {
  return crypto.randomUUID();
}

/**
 * A bullet list whose every item starts with `[ ]` or `[x]` becomes a task list. An item holds one
 * paragraph of inline content plus optional nested task lists; anything else keeps the list a plain
 * bullet list, so nothing is dropped to force the shape.
 */
function taskListFrom(items: readonly string[][]): AdfNode | undefined {
  const tasks: AdfNode[] = [];
  for (const item of items) {
    const marker = TASK_MARKER.exec(item[0] ?? "");
    if (marker === null) return undefined;
    const blocks = parseBlocks([marker[2] ?? "", ...item.slice(1)]);
    const [first, ...rest] = blocks;
    if (first !== undefined && first.type !== "paragraph") return undefined;
    if (rest.some((block) => block.type !== "taskList")) return undefined;
    const content = (first?.content as AdfNode[] | undefined) ?? [];
    tasks.push({
      type: "taskItem",
      attrs: { localId: localId(), state: marker[1] === " " ? "TODO" : "DONE" },
      ...(content.length > 0 ? { content } : {}),
    });
    tasks.push(...rest);
  }
  return { type: "taskList", attrs: { localId: localId() }, content: tasks };
}

function parseBlocks(lines: readonly string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const language = fence[2];
      const ticks = /`+/.exec(line)?.[0].length ?? 3;
      // Only a bare fence at least as long as the opening one closes the block, so a shorter fence
      // inside (a code sample showing markdown) stays code.
      const closing = new RegExp(`^\\s*\`{${ticks},}\\s*$`);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index] ?? "")) {
        body.push(dedent(lines[index] ?? "", (fence[1] ?? "").length));
        index += 1;
      }
      // An unterminated fence still ends here; index lands past the closing line when there is one.
      index += 1;
      const text = body.join("\n");
      nodes.push({
        type: "codeBlock",
        ...(language !== undefined && language.length > 0 ? { attrs: { language } } : {}),
        ...(text.length > 0 ? { content: [textNode(text)] } : {}),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      nodes.push({ type: "heading", attrs: { level: (heading[1] ?? "#").length }, content: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      nodes.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = QUOTE.exec(current);
        if (match !== null) {
          quoted.push(match[1] ?? "");
          index += 1;
          continue;
        }
        // Lazy continuation: an unmarked line directly under a quote stays inside it.
        if (current.trim().length === 0 || startsBlock(current)) break;
        quoted.push(current.trim());
        index += 1;
      }
      nodes.push({ type: "blockquote", content: withBlock(parseBlocks(quoted)) });
      continue;
    }

    if (startsTable(lines, index)) {
      const table = parseTable(lines, index);
      nodes.push(table.node);
      index = table.next;
      continue;
    }

    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const list = collectListItems(lines, index, ordered);
      index = list.next;
      const tasks = ordered ? undefined : taskListFrom(list.items);
      if (tasks !== undefined) {
        nodes.push(tasks);
        continue;
      }
      nodes.push({
        type: ordered ? "orderedList" : "bulletList",
        ...(ordered && list.start !== 1 ? { attrs: { order: list.start } } : {}),
        content: list.items.map((item) => ({ type: "listItem", content: withBlock(parseBlocks(item)) })),
      });
      continue;
    }

    const block: string[] = [];
    while (index < lines.length && !startsBlock(lines[index] ?? "") && !(block.length > 0 && startsTable(lines, index))) {
      block.push((lines[index] ?? "").trim());
      index += 1;
    }
    nodes.push(paragraph(block));
  }

  return nodes;
}

/** True for a value that is already an ADF document, so a caller-built one passes through untouched. */
export function isAdfDocument(value: unknown): value is AdfDocument {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc";
}

/** Converts markdown to an ADF document. An empty input still yields a valid empty paragraph. */
export function markdownToAdf(markdown: string): AdfDocument {
  const content = parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n"));
  return { type: "doc", version: 1, content: content.length > 0 ? content : [{ type: "paragraph", content: [] }] };
}
