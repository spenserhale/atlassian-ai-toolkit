/**
 * Atlassian Document Format to markdown, for reading Confluence pages.
 *
 * The output is the markdown `markdownToAdf` reads back, so a supported construct round-trips.
 * Content markdown cannot express is never silently dropped: opaque nodes (macros, images, mentions)
 * become visible `[[cf:kind detail]]` placeholders, containers (panels, expands, layouts, bodied
 * macros) show their inner content between `[[cf:kind]]` / `[[/cf:kind]]` markers, and formatting
 * that is lost (underline, colour, alignment) is counted. Every such case is reported in `lossy`, so
 * a caller can tell whether writing the markdown back would lose something.
 */
import { AtlassianFieldError } from "./errors.js";
import type { AdfDocument, AdfNode } from "./adf.js";

export interface ConfluenceLossyItem {
  /** What markdown cannot carry, for example `macro`, `image`, `underline`. */
  readonly kind: string;
  readonly count: number;
  /** Macro keys, panel types, and similar, when the kind has them. */
  readonly details?: readonly string[];
  /** True for formatting that is lost outright; false for content shown as a placeholder. */
  readonly dropped: boolean;
}

export interface AdfMarkdownResult {
  readonly markdown: string;
  readonly lossy: readonly ConfluenceLossyItem[];
}

interface LossyEntry {
  count: number;
  details: Set<string>;
  dropped: boolean;
}

interface Context {
  readonly lossy: Map<string, LossyEntry>;
  inTable: boolean;
}

type Mark = { readonly type: string; readonly attrs?: Record<string, unknown> };

const SUPPORTED_MARKS = ["link", "code", "strong", "em", "strike"] as const;

/** Marks that carry no visible formatting, so losing them loses nothing a reader would notice. */
const IGNORED_MARKS = new Set(["fragment", "dataConsumer"]);

const MARK_KINDS: Record<string, string> = {
  underline: "underline",
  textColor: "text colour",
  backgroundColor: "background colour",
  subsup: "sub/superscript",
  border: "border",
  annotation: "inline comment",
};

const BLOCK_MARK_KINDS: Record<string, string> = {
  alignment: "alignment",
  indentation: "indentation",
  breakout: "width",
};

function note(ctx: Context, kind: string, dropped: boolean, detail?: string): void {
  const entry = ctx.lossy.get(kind) ?? { count: 0, details: new Set<string>(), dropped };
  entry.count += 1;
  if (detail !== undefined && detail.length > 0) entry.details.add(detail);
  ctx.lossy.set(kind, entry);
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? (node.content as AdfNode[]) : [];
}

function attrs(node: AdfNode): Record<string, unknown> {
  return typeof node.attrs === "object" && node.attrs !== null ? (node.attrs as Record<string, unknown>) : {};
}

function marksOf(node: AdfNode): Mark[] {
  return Array.isArray(node.marks) ? (node.marks as Mark[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** A placeholder detail on one line, without the token's own closing brackets. */
function detailText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\]\]/g, "] ]").trim();
}

function token(kind: string, detail?: string): string {
  const cleaned = detail === undefined ? "" : detailText(detail);
  return cleaned.length > 0 ? `[[cf:${kind} ${cleaned}]]` : `[[cf:${kind}]]`;
}

function noteBlockMarks(ctx: Context, node: AdfNode): void {
  for (const mark of marksOf(node)) {
    const kind = BLOCK_MARK_KINDS[mark.type];
    if (kind !== undefined) note(ctx, kind, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Inline

const WORD_CHAR = /[A-Za-z0-9_]/;

/** Escapes a backslash that the writer would otherwise read as an escape. */
function escapeBackslashes(text: string): string {
  return text.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\");
}

/** Escapes text so the writer reads it back as the same plain text rather than as markup. */
function escapeText(text: string, ctx: Context): string {
  let out = escapeBackslashes(text)
    .replace(/[*`]/g, (char) => `\\${char}`)
    .replace(/~~/g, "\\~\\~")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/\](?=\()/g, "\\]")
    // An underscore only opens or closes emphasis at a word boundary, so `snake_case` stays as is.
    .replace(/_/g, (char, offset: number, whole: string) => {
      const before = whole[offset - 1];
      const after = whole[offset + 1];
      const boundary = before === undefined || !WORD_CHAR.test(before) || after === undefined || !WORD_CHAR.test(after);
      return boundary ? "\\_" : char;
    });
  if (ctx.inTable) out = out.replace(/\|/g, "\\|");
  return out;
}

/** Inside a mark the writer takes content literally apart from escapes, so only the delimiter and backslashes need escaping. */
function escapeInMark(text: string, delimiter: string, ctx: Context): string {
  let out = escapeBackslashes(text);
  out = out.replace(new RegExp(`\\${delimiter}`, "g"), `\\${delimiter}`);
  if (ctx.inTable) out = out.replace(/\|/g, "\\|");
  return out;
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const padded = text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && text.trim().length > 0) ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function linkHref(href: string): string {
  // The writer accepts one level of balanced parentheses and no whitespace in an href.
  const balanced = /^(?:[^()\s]|\([^()\s]*\))+$/.test(href);
  return balanced ? href : href.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Moves leading and trailing whitespace outside a delimiter pair, where CommonMark requires it. */
function wrap(text: string, open: string, close: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, lead = "", body = "", trail = ""] = match ?? [];
  return body.length === 0 ? text : `${lead}${open}${body}${close}${trail}`;
}

function renderText(node: AdfNode, ctx: Context): string {
  const text = str(node.text);
  const supported: Mark[] = [];
  for (const mark of marksOf(node)) {
    if ((SUPPORTED_MARKS as readonly string[]).includes(mark.type)) supported.push(mark);
    else if (!IGNORED_MARKS.has(mark.type)) note(ctx, MARK_KINDS[mark.type] ?? mark.type, true);
  }
  if (supported.length === 0) return escapeText(text, ctx);

  // The writer does not nest marks, so only the most significant one is kept.
  if (supported.length > 1) note(ctx, "nested formatting", true);
  const mark = SUPPORTED_MARKS.map((type) => supported.find((candidate) => candidate.type === type)).find((candidate) => candidate !== undefined) as Mark;

  if (mark.type === "code") return codeSpan(text);
  if (mark.type === "link") {
    const href = str(mark.attrs?.href);
    const label = escapeBackslashes(text).replace(/\]/g, "\\]");
    return `[${ctx.inTable ? label.replace(/\|/g, "\\|") : label}](${linkHref(href)})`;
  }
  if (mark.type === "strong") return wrap(escapeInMark(text, "*", ctx), "**", "**");
  if (mark.type === "em") return wrap(escapeInMark(text, "*", ctx), "*", "*");
  return wrap(escapeInMark(text, "~", ctx), "~~", "~~");
}

/** Adjacent text nodes with the same marks render as one span, so `**a****b**` never appears. */
function mergeText(nodes: readonly AdfNode[]): AdfNode[] {
  const merged: AdfNode[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) {
      merged[merged.length - 1] = { ...last, text: `${str(last.text)}${str(node.text)}` };
    } else merged.push(node);
  }
  return merged;
}

function isoDate(timestamp: unknown): string {
  const ms = Number(timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : str(timestamp);
}

function renderInline(nodes: readonly AdfNode[], ctx: Context, breakAs = "\n"): string {
  let out = "";
  for (const node of mergeText(nodes)) {
    const a = attrs(node);
    switch (node.type) {
      case "text":
        out += renderText(node, ctx);
        break;
      case "hardBreak":
        out += breakAs;
        break;
      case "mention":
        note(ctx, "mention", false);
        out += token("mention", str(a.text) || str(a.id));
        break;
      case "emoji":
        note(ctx, "emoji", true);
        out += escapeText(str(a.text) || str(a.shortName), ctx);
        break;
      case "date":
        note(ctx, "date", false);
        out += token("date", isoDate(a.timestamp));
        break;
      case "status":
        note(ctx, "status", false);
        out += token("status", str(a.text));
        break;
      case "inlineCard":
        if (str(a.url).length > 0) {
          note(ctx, "smart link", true);
          out += `[${str(a.url)}](${linkHref(str(a.url))})`;
        } else {
          note(ctx, "smart link", false);
          out += token("link");
        }
        break;
      case "inlineExtension":
        note(ctx, "macro", false, str(a.extensionKey));
        out += token("macro", str(a.extensionKey));
        break;
      case "mediaInline":
        note(ctx, "file", false);
        out += token("file", str(a.alt) || str(a.__fileName));
        break;
      case "placeholder":
        break;
      default:
        note(ctx, node.type, false);
        out += token(node.type);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks

/** Escapes a line start the writer would read as a block marker. */
function escapeLineStart(line: string): string {
  if (/^\s*#{1,6}(\s|$)/.test(line)) return line.replace("#", "\\#");
  if (/^\s*>/.test(line)) return line.replace(">", "\\>");
  if (/^\s*[-+](\s|$)/.test(line)) return line.replace(/[-+]/, (char) => `\\${char}`);
  if (/^\s*\d+[.)](\s|$)/.test(line)) return line.replace(/(\d+)([.)])/, "$1\\$2");
  if (/^\s{0,3}(?:_{3,}|={3,})\s*$/.test(line)) return `\\${line.trimStart()}`;
  return line;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

function renderParagraph(node: AdfNode, ctx: Context): string {
  noteBlockMarks(ctx, node);
  return renderInline(children(node), ctx)
    .split("\n")
    .map(escapeLineStart)
    .join("\n");
}

function renderListItem(blocks: readonly AdfNode[], marker: string, ctx: Context): string {
  const width = " ".repeat(marker.length);
  const parts: string[] = [];
  for (const [index, block] of blocks.entries()) {
    const rendered = renderBlock(block, ctx);
    if (index === 0) {
      parts.push(`${marker}${indent(rendered, width).slice(width.length)}`);
      continue;
    }
    const isList = block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList";
    parts.push(`${isList ? "\n" : "\n\n"}${indent(rendered, width)}`);
  }
  return parts.length > 0 ? parts.join("") : marker.trimEnd();
}

function renderTaskList(node: AdfNode, ctx: Context): string {
  const lines: string[] = [];
  for (const child of children(node)) {
    if (child.type === "taskItem") {
      const done = attrs(child).state === "DONE";
      lines.push(`- [${done ? "x" : " "}] ${renderInline(children(child), ctx).split("\n").join("\n  ")}`.trimEnd());
    } else if (child.type === "taskList") {
      lines.push(indent(renderTaskList(child, ctx), "  "));
    } else {
      lines.push(renderBlock(child, ctx));
    }
  }
  return lines.join("\n");
}

function renderCodeBlock(node: AdfNode, ctx: Context): string {
  noteBlockMarks(ctx, node);
  const text = children(node).map((child) => str(child.text)).join("");
  const longest = Math.max(2, ...Array.from(text.matchAll(/^\s*(`{3,})/gm), (match) => (match[1] ?? "").length));
  const fence = "`".repeat(longest + 1);
  const language = str(attrs(node).language);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** A cell the GitHub table syntax can hold: at most one paragraph of inline content. */
function simpleCell(cell: AdfNode): boolean {
  const a = attrs(cell);
  if (Number(a.colspan ?? 1) > 1 || Number(a.rowspan ?? 1) > 1) return false;
  const content = children(cell);
  return content.length <= 1 && content.every((block) => block.type === "paragraph");
}

function renderTable(node: AdfNode, ctx: Context): string {
  const rows = children(node).filter((row) => row.type === "tableRow");
  const simple = rows.every((row) => children(row).every(simpleCell));
  const a = attrs(node);
  if (a.isNumberColumnEnabled === true || (a.layout !== undefined && a.layout !== "default" && a.layout !== "center") || a.width !== undefined) {
    note(ctx, "table layout", true);
  }
  if (!simple) note(ctx, "table", false, "merged cells or blocks in cells");

  const width = Math.max(1, ...rows.map((row) => children(row).length));
  const previous = ctx.inTable;
  ctx.inTable = true;
  const rendered = rows.map((row, rowIndex) =>
    Array.from({ length: width }, (_, column) => {
      const cell = children(row)[column];
      if (cell === undefined) return "";
      const ca = attrs(cell);
      if (ca.colwidth !== undefined || ca.background !== undefined) note(ctx, "table layout", true);
      if ((rowIndex === 0) !== (cell.type === "tableHeader")) note(ctx, "table header", true);
      if (simpleCell(cell)) return renderInline(children(children(cell)[0] ?? { type: "paragraph" }), ctx, " ");
      return children(cell)
        .map((block) => renderBlock(block, ctx).replace(/\s*\n\s*/g, " "))
        .join(" / ");
    })
  );
  ctx.inTable = previous;

  const line = (cells: readonly string[]) => `| ${cells.map((cell) => (cell.length > 0 ? cell : " ")).join(" | ")} |`;
  const [header = [], ...body] = rendered;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}

function renderContainer(kind: string, detail: string, inner: readonly AdfNode[], ctx: Context): string {
  const body = renderBlocks(inner, ctx);
  return `${token(kind, detail)}\n${body.length > 0 ? `${body}\n` : ""}[[/cf:${kind}]]`;
}

function mediaName(media: AdfNode | undefined): string {
  const a = media === undefined ? {} : attrs(media);
  return str(a.alt) || str(a.__fileName) || str(a.url);
}

function renderBlock(node: AdfNode, ctx: Context): string {
  const a = attrs(node);
  switch (node.type) {
    case "paragraph":
      return renderParagraph(node, ctx);
    case "heading": {
      noteBlockMarks(ctx, node);
      const level = Math.min(6, Math.max(1, Number(a.level ?? 1)));
      return `${"#".repeat(level)} ${renderInline(children(node), ctx, " ")}`;
    }
    case "bulletList":
      return children(node)
        .map((item) => renderListItem(children(item), "- ", ctx))
        .join("\n");
    case "orderedList": {
      const start = Number(a.order ?? 1);
      return children(node)
        .map((item, index) => renderListItem(children(item), `${start + index}. `, ctx))
        .join("\n");
    }
    case "taskList":
      return renderTaskList(node, ctx);
    case "codeBlock":
      return renderCodeBlock(node, ctx);
    case "blockquote":
      return renderBlocks(children(node), ctx)
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return renderTable(node, ctx);
    case "panel":
      note(ctx, "panel", false, str(a.panelType));
      return renderContainer("panel", str(a.panelType), children(node), ctx);
    case "expand":
    case "nestedExpand":
      noteBlockMarks(ctx, node);
      note(ctx, "expand", false);
      return renderContainer("expand", str(a.title), children(node), ctx);
    case "bodiedExtension":
      note(ctx, "macro", false, str(a.extensionKey));
      return renderContainer("macro", str(a.extensionKey), children(node), ctx);
    case "layoutSection":
      noteBlockMarks(ctx, node);
      note(ctx, "layout", false);
      return children(node)
        .map((column) => renderContainer("layout", attrs(column).width !== undefined ? `${str(attrs(column).width)}%` : "", children(column), ctx))
        .join("\n\n");
    case "extension":
      note(ctx, "macro", false, str(a.extensionKey));
      return token("macro", str(a.extensionKey));
    case "mediaSingle":
      noteBlockMarks(ctx, node);
      note(ctx, "image", false);
      return token("image", mediaName(children(node).find((child) => child.type === "media")));
    case "mediaGroup":
      return children(node)
        .map((media) => {
          note(ctx, "file", false);
          return token("file", mediaName(media));
        })
        .join("\n");
    case "decisionList":
      note(ctx, "decision", false);
      return token("decision", `${children(node).length} item${children(node).length === 1 ? "" : "s"}`);
    default:
      note(ctx, node.type, false);
      return token(node.type);
  }
}

function renderBlocks(nodes: readonly AdfNode[], ctx: Context): string {
  return nodes
    .map((node) => renderBlock(node, ctx))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function lossyList(ctx: Context): ConfluenceLossyItem[] {
  return Array.from(ctx.lossy.entries())
    .map(([kind, entry]) => ({
      kind,
      count: entry.count,
      ...(entry.details.size > 0 ? { details: Array.from(entry.details).sort() } : {}),
      dropped: entry.dropped,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

function nodesOf(input: AdfDocument | readonly AdfNode[]): readonly AdfNode[] {
  return Array.isArray(input) ? input : (input as AdfDocument).content;
}

/** Converts ADF blocks (or a whole document) to markdown and reports what markdown could not carry. */
export function adfToMarkdown(input: AdfDocument | readonly AdfNode[]): AdfMarkdownResult {
  const ctx: Context = { lossy: new Map(), inTable: false };
  const markdown = renderBlocks(nodesOf(input), ctx);
  return { markdown, lossy: lossyList(ctx) };
}

/** What a markdown write would lose if it replaced these nodes. */
export function adfLossyIn(input: AdfDocument | readonly AdfNode[]): ConfluenceLossyItem[] {
  return [...adfToMarkdown(input).lossy];
}

/** `macro x3 (toc, jira), image x2`. */
export function formatLossy(lossy: readonly ConfluenceLossyItem[]): string {
  return lossy
    .map((item) => `${item.kind} x${item.count}${item.details !== undefined && item.details.length > 0 ? ` (${item.details.join(", ")})` : ""}`)
    .join(", ");
}

/** True when markdown holds a `[[cf:` placeholder or marker, which must never be written as literal text. */
export function containsConfluencePlaceholder(markdown: string): boolean {
  return /(?<!\\)\[\[\/?cf:/.test(markdown);
}

// ---------------------------------------------------------------------------------------------
// Sections

export interface AdfSection {
  /** The node list holding the section: the document body or a layout column. */
  readonly container: AdfNode[];
  /** Index of the heading in `container`. */
  readonly start: number;
  /** Index after the last node of the section. */
  readonly end: number;
  readonly level: number;
  readonly title: string;
  /** Titles of the enclosing headings and this one, outermost first. */
  readonly path: readonly string[];
  /** The shortest selector that resolves to this section alone. */
  readonly selector: string;
}

function plainText(nodes: readonly AdfNode[]): string {
  return nodes
    .map((node) => (node.type === "text" ? str(node.text) : node.type === "hardBreak" ? " " : str(attrs(node).text)))
    .join("")
    .trim();
}

function collectSections(container: AdfNode[], out: Array<Omit<AdfSection, "selector">>): void {
  const stack: Array<{ level: number; title: string }> = [];
  for (const [index, node] of container.entries()) {
    if (node.type === "layoutSection") {
      for (const column of children(node)) collectSections(children(column), out);
      continue;
    }
    if (node.type !== "heading") continue;
    const level = Number(attrs(node).level ?? 1);
    const title = plainText(children(node));
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    let end = container.length;
    for (let next = index + 1; next < container.length; next += 1) {
      const candidate = container[next];
      if (candidate?.type === "heading" && Number(attrs(candidate).level ?? 1) <= level) {
        end = next;
        break;
      }
    }
    out.push({ container, start: index, end, level, title, path: [...stack.map((entry) => entry.title), title] });
    stack.push({ level, title });
  }
}

interface ParsedSelector {
  readonly segments: readonly string[];
  readonly occurrence?: number;
}

function parseSelector(selector: string): ParsedSelector {
  const occurrence = /^(.*?)\s*\[(\d+)\]\s*$/.exec(selector);
  const body = occurrence !== null ? occurrence[1] ?? "" : selector;
  return {
    segments: body.split(/\s+>\s+/).map((segment) => segment.trim().toLowerCase()),
    ...(occurrence !== null ? { occurrence: Number(occurrence[2]) } : {}),
  };
}

function matchesSegments(path: readonly string[], segments: readonly string[]): boolean {
  if (segments.length > path.length) return false;
  const tail = path.slice(path.length - segments.length).map((title) => title.toLowerCase());
  return tail.every((title, index) => title === segments[index]);
}

function candidatesFor<T extends { path: readonly string[] }>(sections: readonly T[], selector: string): T[] {
  const parsed = parseSelector(selector);
  const matches = sections.filter((section) => matchesSegments(section.path, parsed.segments));
  if (parsed.occurrence === undefined) return matches;
  const picked = matches[parsed.occurrence - 1];
  return picked === undefined ? [] : [picked];
}

/** Every heading section in the document body and in layout columns, each with a unique selector. */
export function listAdfSections(doc: AdfDocument | readonly AdfNode[]): AdfSection[] {
  const raw: Array<Omit<AdfSection, "selector">> = [];
  collectSections(nodesOf(doc) as AdfNode[], raw);
  return raw.map((section) => {
    const options: string[] = [];
    for (let length = 1; length <= section.path.length; length += 1) options.push(section.path.slice(section.path.length - length).join(" > "));
    const unique = options.find((option) => {
      const found = candidatesFor(raw, option);
      return found.length === 1 && found[0] === section;
    });
    if (unique !== undefined) return { ...section, selector: unique };
    const full = section.path.join(" > ");
    const occurrence = candidatesFor(raw, full).indexOf(section) + 1;
    return { ...section, selector: `${full} [${occurrence}]` };
  });
}

/**
 * Resolves a selector: a heading, a `Parent > Child` path (matched from the end), optionally with
 * ` [n]` for the nth match. Fails with the exact selectors when it matches none or several.
 */
export function findAdfSection(doc: AdfDocument | readonly AdfNode[], selector: string): AdfSection {
  const sections = listAdfSections(doc);
  const matches = candidatesFor(sections, selector);
  if (matches.length === 1) return matches[0] as AdfSection;
  if (matches.length === 0) {
    throw new AtlassianFieldError(`No section matches "${selector}"`, "section_not_found", {
      section: selector,
      available: sections.map((section) => section.selector),
    });
  }
  throw new AtlassianFieldError(
    `"${selector}" matches ${matches.length} sections; use one of: ${matches.map((section) => `"${section.selector}"`).join(", ")}`,
    "section_ambiguous",
    { section: selector, candidates: matches.map((section) => section.selector) }
  );
}

export interface AdfOutlineEntry {
  readonly selector: string;
  readonly level: number;
  readonly title: string;
  /** Markdown characters in the section, including its subsections. */
  readonly chars: number;
}

/** The headings with each section's markdown size; `intro` sizes the content before the first heading. */
export function adfOutline(doc: AdfDocument | readonly AdfNode[]): { intro: number; sections: AdfOutlineEntry[] } {
  const nodes = nodesOf(doc);
  const firstHeading = nodes.findIndex((node) => node.type === "heading" || node.type === "layoutSection");
  const intro = adfToMarkdown(nodes.slice(0, firstHeading === -1 ? nodes.length : firstHeading)).markdown.length;
  const sections = listAdfSections(doc).map((section) => ({
    selector: section.selector,
    level: section.level,
    title: section.title,
    chars: adfToMarkdown(section.container.slice(section.start, section.end)).markdown.length,
  }));
  return { intro, sections };
}
