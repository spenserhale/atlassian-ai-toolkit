/**
 * Pure edit operations on a Confluence page's ADF. Each returns a new document and leaves every
 * node outside the change exactly as stored, which is what keeps macros and images intact on a
 * targeted edit. No HTTP here, so each operation is unit-testable on its own.
 */
import type { AdfDocument, AdfNode } from "./adf.js";
import { adfLossyIn, findAdfSection } from "./adf-markdown.js";
import type { ConfluenceLossyItem } from "./adf-markdown.js";
import { AtlassianFieldError } from "./errors.js";

function cloneDoc(doc: AdfDocument): AdfDocument {
  return structuredClone(doc) as AdfDocument;
}

function children(node: AdfNode): AdfNode[] | undefined {
  return Array.isArray(node.content) ? (node.content as AdfNode[]) : undefined;
}

function headingText(node: AdfNode | undefined): string | undefined {
  if (node?.type !== "heading") return undefined;
  return (children(node) ?? [])
    .map((child) => (typeof child.text === "string" ? child.text : ""))
    .join("")
    .trim()
    .toLowerCase();
}

export interface SectionReplaceResult {
  readonly doc: AdfDocument;
  readonly selector: string;
  /** The nodes that were replaced, for the lossy check and the dry-run size. */
  readonly removed: readonly AdfNode[];
}

/**
 * Replaces everything under a heading, up to the next heading of the same or a higher level. The
 * heading stays. A replacement that repeats the heading itself does not duplicate it.
 */
export function replaceAdfSection(doc: AdfDocument, selector: string, blocks: readonly AdfNode[]): SectionReplaceResult {
  const next = cloneDoc(doc);
  const section = findAdfSection(next, selector);
  const heading = section.container[section.start];
  let replacement = [...blocks];
  const first = replacement[0];
  if (
    first?.type === "heading" &&
    Number((first.attrs as { level?: unknown } | undefined)?.level) === section.level &&
    headingText(first) === headingText(heading)
  ) {
    replacement = replacement.slice(1);
  }
  const removed = section.container.splice(section.start + 1, section.end - section.start - 1, ...replacement);
  return { doc: next, selector: section.selector, removed };
}

export function appendAdfBlocks(doc: AdfDocument, blocks: readonly AdfNode[]): AdfDocument {
  const next = cloneDoc(doc);
  return { ...next, content: [...next.content, ...blocks] };
}

export function prependAdfBlocks(doc: AdfDocument, blocks: readonly AdfNode[]): AdfDocument {
  const next = cloneDoc(doc);
  return { ...next, content: [...blocks, ...next.content] };
}

interface Run {
  readonly owner: AdfNode[];
  readonly start: number;
  readonly nodes: readonly AdfNode[];
}

/** Runs of consecutive text nodes; a mention, macro, or line break ends a run. */
function collectRuns(nodes: AdfNode[], out: Run[]): void {
  let runStart = -1;
  const flush = (end: number) => {
    if (runStart !== -1) out.push({ owner: nodes, start: runStart, nodes: nodes.slice(runStart, end) });
    runStart = -1;
  };
  for (const [index, node] of nodes.entries()) {
    if (node.type === "text" && typeof node.text === "string") {
      if (runStart === -1) runStart = index;
      continue;
    }
    flush(index);
    const inner = children(node);
    if (inner !== undefined) collectRuns(inner, out);
  }
  flush(nodes.length);
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

function rebuildRun(run: Run, find: string, replace: string): AdfNode[] {
  const text = run.nodes.map((node) => String(node.text)).join("");
  const owners: number[] = [];
  run.nodes.forEach((node, index) => {
    for (let char = 0; char < String(node.text).length; char += 1) owners.push(index);
  });

  const pieces: Array<{ text: string; source: number }> = [];
  const push = (piece: string, source: number) => {
    if (piece.length === 0) return;
    const last = pieces[pieces.length - 1];
    if (last !== undefined && last.source === source) last.text += piece;
    else pieces.push({ text: piece, source });
  };
  const matches = new Set(occurrences(text, find));
  for (let index = 0; index < text.length; ) {
    if (matches.has(index)) {
      push(replace, owners[index] ?? 0);
      index += find.length;
      continue;
    }
    push(text[index] ?? "", owners[index] ?? 0);
    index += 1;
  }

  // Pieces from different source nodes that share marks merge back into one text node.
  const nodes: AdfNode[] = [];
  for (const piece of pieces) {
    const source = run.nodes[piece.source] as AdfNode;
    const last = nodes[nodes.length - 1];
    if (last !== undefined && JSON.stringify(last.marks ?? []) === JSON.stringify(source.marks ?? [])) {
      nodes[nodes.length - 1] = { ...last, text: `${String(last.text)}${piece.text}` };
    } else nodes.push({ ...source, text: piece.text });
  }
  return nodes;
}

export interface FindReplaceResult {
  readonly doc: AdfDocument;
  readonly matches: number;
}

/**
 * Replaces exact text. A match may cross bold or italic boundaries inside one run of text, and the
 * replacement takes the marks of the first matched character. Fails with `no_match` on zero
 * matches, and with `multiple_matches` on more than one unless `all` is set.
 */
export function findReplaceAdf(doc: AdfDocument, find: string, replace: string, all = false): FindReplaceResult {
  if (find.length === 0) throw new AtlassianFieldError("--find must not be empty", "invalid_request");
  const next = cloneDoc(doc);
  const runs: Run[] = [];
  collectRuns(next.content as AdfNode[], runs);

  const counts = runs.map((run) => occurrences(run.nodes.map((node) => String(node.text)).join(""), find).length);
  const matches = counts.reduce((sum, count) => sum + count, 0);
  if (matches === 0) throw new AtlassianFieldError(`"${find}" does not occur on the page`, "no_match", { find, matches: 0 });
  if (matches > 1 && !all) {
    throw new AtlassianFieldError(`"${find}" occurs ${matches} times; pass --all to replace every one, or make --find more specific`, "multiple_matches", {
      find,
      matches,
    });
  }

  // Later runs first, so splicing one run never shifts the start of another in the same array.
  runs
    .map((run, index) => ({ run, count: counts[index] ?? 0 }))
    .filter((entry) => entry.count > 0)
    .reverse()
    .forEach(({ run }) => run.owner.splice(run.start, run.nodes.length, ...rebuildRun(run, find, replace)));

  return { doc: next, matches };
}

/** What would be lost by replacing these nodes with markdown-authored content. */
export function lossyReplaced(nodes: readonly AdfNode[]): ConfluenceLossyItem[] {
  return adfLossyIn(nodes);
}
