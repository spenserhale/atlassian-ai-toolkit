/** Helpers for the Confluence page methods: body preparation, CQL building, and search hit shaping. */
import { isAdfDocument, markdownToAdf } from "./adf.js";
import type { AdfDocument, AdfNode } from "./adf.js";
import { containsConfluencePlaceholder } from "./adf-markdown.js";
import { AtlassianAuthError, AtlassianError, AtlassianFieldError, AtlassianNotFoundError } from "./errors.js";
import type { ConfluenceBodyFormat, ConfluenceBodyInput, ConfluenceSearchField, ConfluenceSearchHit } from "./types.js";
import type { z } from "zod";
import type { ConfluenceSearchResultSchema } from "./types.js";

/** Bodies over this many characters come back as an outline unless the caller asks for all of it. */
export const CONFLUENCE_SIZE_GUARD = 12_000;

/** Length of a `short` search excerpt. */
export const CONFLUENCE_SHORT_EXCERPT = 90;

/** Parses the ADF a v2 page returns as a JSON string. A page with no body reads as an empty document. */
export function parseAdfValue(value: string | undefined): AdfDocument {
  if (value === undefined || value.trim().length === 0) return { type: "doc", version: 1, content: [] };
  const parsed: unknown = JSON.parse(value);
  if (!isAdfDocument(parsed)) throw new AtlassianFieldError("Confluence returned a body that is not an ADF document", "upstream_error");
  return { ...parsed, content: Array.isArray(parsed.content) ? parsed.content : [] };
}

export interface PreparedConfluenceBody {
  readonly format: ConfluenceBodyFormat;
  readonly representation: "atlas_doc_format" | "storage";
  /** The value sent to Confluence. */
  readonly value: string;
  /** The ADF document, for markdown and ADF input. */
  readonly doc?: AdfDocument;
  /** The ADF blocks, for splicing into an existing page. */
  readonly blocks: readonly AdfNode[];
  /** Body size in the caller's own format. */
  readonly chars: number;
}

/**
 * Turns a caller's body into what Confluence takes. Markdown becomes ADF and may not hold a `[[cf:`
 * placeholder, since those are for display and would be written as literal text.
 */
export function prepareConfluenceBody(body: ConfluenceBodyInput): PreparedConfluenceBody {
  const format = body.format ?? "markdown";
  if (format === "storage") {
    if (typeof body.value !== "string") throw new AtlassianFieldError("A storage body must be a string of storage XHTML", "invalid_request");
    return { format, representation: "storage", value: body.value, blocks: [], chars: body.value.length };
  }
  if (format === "adf") {
    let doc: unknown = body.value;
    if (typeof doc === "string") {
      try {
        doc = JSON.parse(doc);
      } catch (err) {
        throw new AtlassianFieldError(`The ADF body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, "invalid_request");
      }
    }
    if (!isAdfDocument(doc)) throw new AtlassianFieldError('An ADF body must be a document: { "type": "doc", "version": 1, "content": [...] }', "invalid_request");
    const value = JSON.stringify(doc);
    return { format, representation: "atlas_doc_format", value, doc, blocks: [...doc.content], chars: value.length };
  }
  if (typeof body.value !== "string") throw new AtlassianFieldError("A markdown body must be a string", "invalid_request");
  if (containsConfluencePlaceholder(body.value)) {
    throw new AtlassianFieldError(
      "The body holds a [[cf:...]] placeholder. Placeholders only mark content on read and cannot be written back; edit around that content with a targeted edit instead",
      "placeholder_in_body"
    );
  }
  const doc = markdownToAdf(body.value);
  return { format, representation: "atlas_doc_format", value: JSON.stringify(doc), doc, blocks: [...doc.content], chars: body.value.length };
}

/** Escapes a value placed inside a double-quoted CQL string. */
export function cqlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildConfluenceCql(opts: { cql?: string; text?: string; space?: string; type?: string }): string {
  const cql = opts.cql?.trim();
  const text = opts.text?.trim();
  if (cql !== undefined && cql.length > 0) {
    if (text !== undefined && text.length > 0) throw new AtlassianFieldError("Pass either cql or text, not both", "invalid_request");
    return cql;
  }
  if (text === undefined || text.length === 0) throw new AtlassianFieldError("Provide a CQL query or search text", "invalid_request");
  const clauses = [`siteSearch ~ "${cqlEscape(text)}"`];
  if (opts.space !== undefined && opts.space.trim().length > 0) clauses.push(`space = "${cqlEscape(opts.space.trim())}"`);
  const type = opts.type?.trim() || "page";
  clauses.push(`type = ${/^[a-z]+$/i.test(type) ? type : `"${cqlEscape(type)}"`}`);
  return clauses.join(" AND ");
}

/** The `cursor` from a v1 `_links.next`, a relative URL such as `/rest/api/search?cql=...&cursor=abc`. */
export function cursorFrom(next: string | undefined): string | undefined {
  if (next === undefined || next.length === 0) return undefined;
  return new URL(next, "https://placeholder.invalid").searchParams.get("cursor") ?? undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Strips search highlight markers and HTML entities, and collapses whitespace. */
export function cleanSearchText(text: string): string {
  return text
    .replace(/@@@(?:end)?hl@@@/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts at a word boundary and marks the cut with an ellipsis. */
export function cutExcerpt(text: string, max = CONFLUENCE_SHORT_EXCERPT): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const space = slice.lastIndexOf(" ");
  return `${(space > max / 2 ? slice.slice(0, space) : slice).trimEnd()}…`;
}

type RawHit = z.infer<typeof ConfluenceSearchResultSchema>;

/** Shapes one search result down to the requested fields, with at most one url. */
export function searchHit(hit: RawHit, fields: readonly ConfluenceSearchField[], excerpt: "none" | "short" | "full", base: string): ConfluenceSearchHit {
  const content = hit.content;
  const spaceFromUrl = /\/spaces\/([^/?#]+)/.exec(hit.resultGlobalContainer?.displayUrl ?? hit.url ?? "")?.[1];
  const webui = content?._links?.webui ?? hit.url;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    switch (field) {
      case "id":
        if (content?.id !== undefined) out.id = content.id;
        break;
      case "title": {
        const title = content?.title ?? hit.title;
        if (title !== undefined) out.title = cleanSearchText(title);
        break;
      }
      case "space": {
        const space = content?.space?.key ?? spaceFromUrl;
        if (space !== undefined) out.space = space;
        break;
      }
      case "type": {
        const type = content?.type ?? hit.entityType;
        if (type !== undefined) out.type = type;
        break;
      }
      case "modified":
        if (hit.lastModified !== undefined) out.modified = hit.lastModified.slice(0, 10);
        break;
      case "excerpt": {
        if (excerpt === "none" || hit.excerpt === undefined) break;
        const text = cleanSearchText(hit.excerpt);
        if (text.length > 0) out.excerpt = excerpt === "short" ? cutExcerpt(text) : text;
        break;
      }
      case "url":
        if (webui !== undefined) out.url = /^https?:/.test(webui) ? webui : `${base}${webui}`;
        break;
      case "version":
        if (content?.version?.number !== undefined) out.version = content.version.number;
        break;
      case "ancestors":
        if (content?.ancestors !== undefined) out.ancestors = content.ancestors.map((ancestor) => ({ id: ancestor.id, ...(ancestor.title !== undefined ? { title: ancestor.title } : {}) }));
        break;
      case "status":
        if (content?.status !== undefined) out.status = content.status;
        break;
    }
  }
  return out as ConfluenceSearchHit;
}

/** Maps a failed page create to the case the caller can act on. The space was already resolved. */
export function translateConfluenceCreateError(err: unknown, title: string, spaceKey: string): unknown {
  if (err instanceof AtlassianNotFoundError || (err instanceof AtlassianAuthError && err.statusCode === 403)) {
    return new AtlassianFieldError(`You do not have permission to create pages in space ${spaceKey}`, "permission_denied", { space: spaceKey });
  }
  if (!(err instanceof AtlassianError)) return err;
  if (err.statusCode === 413) return new AtlassianFieldError("The page body is over Confluence's 5 MB request limit", "body_too_large");
  if (err.statusCode === 400 && /title/i.test(err.message) && /exist|already|same/i.test(err.message)) {
    return new AtlassianFieldError(`A page titled "${title}" already exists in space ${spaceKey}`, "title_exists", { title, space: spaceKey });
  }
  return err;
}
