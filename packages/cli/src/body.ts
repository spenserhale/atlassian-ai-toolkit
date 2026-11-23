import { readFile } from "node:fs/promises";
import type { ConfluenceBodyFormat } from "@atlassian-ai-toolkit/sdk";
import { UsageError } from "./errors.js";

/** The markdown constructs that round-trip, listed in each body-taking command's help. */
export const SUPPORTED_MARKDOWN =
  "Markdown: # headings, paragraphs, **bold** *em* ~~strike~~ `code` [link](url), \\ escapes, - / 1. lists (nested),\n" +
  "- [ ] / - [x] tasks, ``` fenced code ```, > quotes, ---, | GitHub | tables | (one header row, inline cells).\n" +
  "Marks do not nest. [[cf:...]] placeholders from a read cannot be written back.";

export function parseBodyFormat(value: string | undefined, fallback: ConfluenceBodyFormat = "markdown"): ConfluenceBodyFormat {
  if (value === undefined) return fallback;
  if (value === "markdown" || value === "storage" || value === "adf") return value;
  throw new UsageError(`--format must be markdown, storage, or adf (got: "${value}")`, undefined, ["markdown", "storage", "adf"]);
}

/** Reads `--body` or `--body-file` (`-` reads stdin). Returns undefined when neither is given. */
export async function readBody(flags: { readonly body?: string; readonly "body-file"?: string }): Promise<string | undefined> {
  if (flags.body !== undefined && flags["body-file"] !== undefined) throw new UsageError("Pass either --body or --body-file, not both");
  if (flags.body !== undefined) return flags.body;
  const path = flags["body-file"];
  if (path === undefined) return undefined;
  if (path === "-") return await Bun.stdin.text();
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new UsageError(`--body-file could not be read: ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
}

export function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive integer (got: "${value}")`);
  return parsed;
}
