import { buildCommand } from "@stricli/core";
import { AtlassianClient, loadConfig } from "@atlassian-ai-toolkit/sdk";
import type { ConfluenceBodyFormat, ConfluenceEditOperation } from "@atlassian-ai-toolkit/sdk";
import { SUPPORTED_MARKDOWN, parseBodyFormat, parsePositiveInt, readBody } from "../body.js";
import { formatEdit } from "../confluence-format.js";
import { UsageError, handleError } from "../errors.js";

interface EditFlags {
  readonly "replace-section"?: string;
  readonly append: boolean;
  readonly prepend: boolean;
  readonly find?: string;
  readonly replace?: string;
  readonly all: boolean;
  readonly title?: string;
  readonly body?: string;
  readonly "body-file"?: string;
  readonly format?: string;
  readonly "expect-version"?: string;
  readonly message?: string;
  readonly "allow-lossy": boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
}

/** Turns the flags into one operation, rejecting combinations that would be ambiguous. */
export function editOperation(flags: EditFlags, body: string | undefined, format: ConfluenceBodyFormat): ConfluenceEditOperation | undefined {
  const section = flags["replace-section"];
  const targeted = [section !== undefined, flags.append, flags.prepend, flags.find !== undefined].filter(Boolean).length;
  if (targeted > 1) throw new UsageError("Pass one of --replace-section, --append, --prepend, or --find per edit");
  if (flags.replace !== undefined && flags.find === undefined) throw new UsageError("--replace needs --find");
  if (flags.all && flags.find === undefined) throw new UsageError("--all needs --find");

  if (flags.find !== undefined) {
    if (flags.replace === undefined) throw new UsageError("--find needs --replace (use --replace \"\" to delete the text)");
    if (flags.find.length === 0) throw new UsageError("--find must not be empty");
    if (body !== undefined) throw new UsageError("--find takes no body");
    return { kind: "findReplace", find: flags.find, replace: flags.replace, all: flags.all };
  }

  const needsBody = section !== undefined || flags.append || flags.prepend;
  if (needsBody && body === undefined) throw new UsageError("This edit needs --body or --body-file");
  if (needsBody && format === "storage") throw new UsageError("Targeted edits take markdown or adf; storage is only for a whole-body replace");
  if (section !== undefined) return { kind: "replaceSection", section, body: { value: body, format } };
  if (flags.append) return { kind: "append", body: { value: body, format } };
  if (flags.prepend) return { kind: "prepend", body: { value: body, format } };
  if (body !== undefined) return { kind: "replaceBody", body: { value: body, format } };
  return undefined;
}

export const confluenceEditCommand = buildCommand({
  docs: {
    brief: "Edit a Confluence page: replace a section, append, prepend, find/replace, retitle, or replace the body",
    fullDescription: [
      "Targeted edits change only that part; macros and images elsewhere stay exactly as stored.",
      "A body with no targeted flag replaces the whole page and needs --expect-version <n> from `get`.",
      "A stale version fails with version_conflict. Replacing content markdown cannot carry fails with",
      "lossy_replace unless --allow-lossy. Confluence may overwrite a diverged unpublished draft; the",
      "output warns when one exists. Watchers are notified per Confluence defaults (no minor-edit switch).",
      SUPPORTED_MARKDOWN,
      "",
      "Examples:",
      '  atlassian confluence edit 123456 --replace-section "Rollout" --body-file rollout.md --expect-version 14',
      '  atlassian confluence edit 123456 --find "v1.4" --replace "v1.5" --all --message "Bump version" --dry-run',
    ].join("\n"),
  },
  parameters: {
    flags: {
      "replace-section": { kind: "parsed", parse: String, brief: "Replace everything under this heading (or path, or path [n])", optional: true },
      append: { kind: "boolean", brief: "Add the body at the end", default: false },
      prepend: { kind: "boolean", brief: "Add the body at the start", default: false },
      find: { kind: "parsed", parse: String, brief: "Exact text to replace; must match once unless --all", optional: true },
      replace: { kind: "parsed", parse: String, brief: "Replacement text for --find", optional: true },
      all: { kind: "boolean", brief: "Replace every --find match", default: false },
      title: { kind: "parsed", parse: String, brief: "New title, alone or with another edit", optional: true },
      body: { kind: "parsed", parse: String, brief: "Body for the edit", optional: true },
      "body-file": { kind: "parsed", parse: String, brief: "File holding the body (- for stdin)", optional: true },
      format: { kind: "parsed", parse: String, brief: "Body format: markdown (default), adf, or storage (whole body only)", optional: true },
      "expect-version": { kind: "parsed", parse: String, brief: "Version you read; required for a whole-body replace", optional: true },
      message: { kind: "parsed", parse: String, brief: "Version comment", optional: true },
      "allow-lossy": { kind: "boolean", brief: "Write even if markdown replaces content it cannot carry", default: false },
      "dry-run": { kind: "boolean", brief: "Report what would change without writing", default: false },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
    positional: { kind: "tuple", parameters: [{ brief: "Page ID", parse: String, placeholder: "page-id" }] },
  },
  async func(this: void, flags: EditFlags, pageId: string) {
    try {
      const format = parseBodyFormat(flags.format);
      const operation = editOperation(flags, await readBody(flags), format);
      if (operation === undefined && flags.title === undefined) {
        throw new UsageError("Nothing to edit: pass --replace-section, --append, --prepend, --find, --title, or a body");
      }
      const client = new AtlassianClient(await loadConfig());
      const result = await client.editConfluencePage(
        pageId,
        { operation, title: flags.title },
        {
          dryRun: flags["dry-run"],
          expectVersion: parsePositiveInt(flags["expect-version"], "--expect-version"),
          allowLossy: flags["allow-lossy"],
          message: flags.message,
        }
      );
      console.log(flags.json ? JSON.stringify(result, null, 2) : formatEdit(result));
    } catch (err) {
      handleError(err, flags.json);
    }
  },
});
