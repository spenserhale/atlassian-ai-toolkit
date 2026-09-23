/**
 * Markdown to Atlassian Document Format.
 *
 * Jira's v3 API rejects a plain string for rich-text fields (`description`, `environment`, textarea
 * custom fields), and callers write markdown, so the conversion belongs in the SDK rather than in
 * every consumer. Coverage is the markdown an issue description actually uses: headings, lists,
 * code blocks, quotes, rules, and inline emphasis, code, and links. Anything unrecognised stays
 * literal paragraph text rather than being dropped.
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

/**
 * One pass of the inline grammar: code, link, strong, strike, emphasis. The emphasis alternatives
 * carry CommonMark's flanking rules, so `user_id_field` and `2 * 3 * 4` stay literal text, and a
 * link href may hold one level of balanced parentheses, as Wikipedia URLs do.
 */
const INLINE =
  /`([^`]+)`|\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|\*\*([^*]+)\*\*|(?<![A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])|~~([^~]+)~~|\*(\S|\S[^*\n]*?\S)\*|(?<![A-Za-z0-9_])_(\S|\S[^_\n]*?\S)_(?![A-Za-z0-9_])/;

function textNode(text: string, marks?: readonly AdfMark[]): AdfNode {
  return marks === undefined || marks.length === 0 ? { type: "text", text } : { type: "text", text, marks };
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

    if (match.index > 0) nodes.push(textNode(rest.slice(0, match.index)));

    const code = match[1];
    const linkText = match[2];
    const linkHref = match[3];
    const strong = match[4] ?? match[5];
    const strike = match[6];
    const emphasis = match[7] ?? match[8];

    if (code !== undefined) nodes.push(textNode(code, [{ type: "code" }]));
    else if (linkHref !== undefined) {
      nodes.push(textNode(linkText !== undefined && linkText.length > 0 ? linkText : linkHref, [{ type: "link", attrs: { href: linkHref } }]));
    } else if (strong !== undefined) nodes.push(textNode(strong, [{ type: "strong" }]));
    else if (strike !== undefined) nodes.push(textNode(strike, [{ type: "strike" }]));
    else if (emphasis !== undefined) nodes.push(textNode(emphasis, [{ type: "em" }]));

    rest = rest.slice(match.index + raw.length);
  }

  if (rest.length > 0) nodes.push(textNode(rest));
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
      const continues = lookahead < lines.length && (indentOf(nextLine) > base || (marker.exec(nextLine)?.[1] ?? "").length === base);
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
      const body: string[] = [];
      index += 1;
      while (index < lines.length && FENCE.exec(lines[index] ?? "") === null) {
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

    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const list = collectListItems(lines, index, ordered);
      index = list.next;
      nodes.push({
        type: ordered ? "orderedList" : "bulletList",
        ...(ordered && list.start !== 1 ? { attrs: { order: list.start } } : {}),
        content: list.items.map((item) => ({ type: "listItem", content: withBlock(parseBlocks(item)) })),
      });
      continue;
    }

    const block: string[] = [];
    while (index < lines.length && !startsBlock(lines[index] ?? "")) {
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
