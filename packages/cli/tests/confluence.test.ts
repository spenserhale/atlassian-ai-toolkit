import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { resolve } from "node:path";
import type { ConfluenceSearchResult } from "@atlassian-ai-toolkit/sdk";
import { editOperation } from "../src/commands/confluence-edit.js";
import { formatCreate, formatEdit, formatPage, formatSearch } from "../src/confluence-format.js";
import { UsageError, errorPayload, exitCodeFor } from "../src/errors.js";
import { AtlassianConfigError, AtlassianFieldError } from "@atlassian-ai-toolkit/sdk";

setDefaultTimeout(20_000);
const BIN = resolve(import.meta.dir, "../src/bin.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ATLASSIAN_KEYCHAIN: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

const excerpt = "Steps for cutting a release, tagging the build, and posting notes to the channel so that…";

function searchResult(hits: number, opts: { titleLength?: number; mixedSpaces?: boolean } = {}): ConfluenceSearchResult {
  return {
    cql: "x",
    results: Array.from({ length: hits }, (_, index) => ({
      id: String(4_000_000_000 + index),
      title: `Runbook ${index} ${"x".repeat(Math.max(0, (opts.titleLength ?? 24) - 10))}`.slice(0, opts.titleLength ?? 24),
      space: opts.mixedSpaces === true && index % 2 === 1 ? "OPS" : "ENG",
      type: "page",
      modified: "2026-10-01",
      excerpt,
    })),
    count: hits,
    total: 143,
    isLast: false,
    nextCursor: "eyJzdGFydCI6MTB9",
  };
}

describe("formatSearch", () => {
  it("fits ten typical hits in under 1,500 characters, naming a shared space and type once", () => {
    const text = formatSearch(searchResult(10));
    expect(text.split("\n")[0]).toBe("10 of 143 (space ENG, type page) more: --cursor eyJzdGFydCI6MTB9");
    expect(text).not.toContain("http");
    expect(text.length).toBeLessThan(1_500);
  });

  it("records the size with long titles and mixed spaces, where the target can be exceeded", () => {
    const text = formatSearch(searchResult(10, { titleLength: 70, mixedSpaces: true }));
    expect(text.split("\n")[1]).toContain("[ENG]");
    // Nothing is cut to force the target; this documents the worst case the spec accepts.
    expect(text.length).toBeGreaterThan(1_500);
    expect(text.length).toBeLessThan(2_300);
  });
});

describe("formatPage", () => {
  const base = {
    id: "1",
    title: "T",
    space: { id: "7", key: "SYN" },
    status: "current",
    version: 4,
    parentId: "9",
    url: "https://example.atlassian.net/wiki/spaces/SYN/pages/1",
    format: "markdown" as const,
    lossy: [{ kind: "macro", count: 2, details: ["toc"], dropped: false }],
  };

  it("prints the header, the lossy line, and the body", () => {
    expect(formatPage({ ...base, body: "# Hi" })).toBe(
      "id: 1\ntitle: T\nspace: SYN\nstatus: current\nversion: 4\nparent: 9\nurl: https://example.atlassian.net/wiki/spaces/SYN/pages/1\nlossy: macro x2 (toc)\n---\n# Hi"
    );
  });

  it("prints the guard hint and an outline with selectors only where they differ from the title", () => {
    const text = formatPage({
      ...base,
      guard: { threshold: 12_000, hint: 'body is 49,213 chars; use --section "<heading>" or --full' },
      outline: { intro: 120, sections: [{ selector: "Setup", level: 1, title: "Setup", chars: 30_100 }, { selector: "Setup > Install [2]", level: 2, title: "Install", chars: 9_000 }] },
    });
    expect(text).toContain('body is 49,213 chars; use --section "<heading>" or --full\noutline:\n  (intro) 120\n  # Setup  30,100\n  ## Install  9,000  --section "Setup > Install [2]"');
  });
});

describe("formatCreate and formatEdit", () => {
  it("never prints a body, and shows the placement path on a dry run", () => {
    const text = formatCreate({
      status: "dry_run",
      title: "New",
      pageStatus: "current",
      space: { id: "7", key: "SYN" },
      parent: { id: "9", title: "Parent", ancestors: [{ id: "1", title: "Root" }] },
      format: "markdown",
      bodyChars: 1234,
    });
    expect(text).toBe("status: dry_run\ntitle: New\npage_status: current\nspace: SYN (7)\nparent: 9 Parent\npath: Root > Parent > New\nbody: 1,234 chars markdown");
  });

  it("reports the edit with sizes, draft warning, and retry", () => {
    const text = formatEdit({ status: "updated", id: "1", title: "T", version: 6, previousVersion: 5, url: "u", operation: "findReplace", matches: 3, chars: { before: 100, after: 104 }, draft: "exists", retried: true });
    expect(text).toBe("status: updated\nid: 1\ntitle: T\nversion: 6\nurl: u\noperation: findReplace\nmatches: 3\nchars: 100 -> 104\ndraft: exists (Confluence may overwrite it if it diverged)\nretried: true (the page changed during the first attempt)");
  });
});

describe("editOperation", () => {
  const flags = { append: false, prepend: false, all: false, "allow-lossy": false, "dry-run": false, json: false };
  const usage = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof UsageError ? err.message : `not usage: ${String(err)}`;
    }
    return "no error";
  };

  it("maps flags to one operation", () => {
    expect(editOperation({ ...flags, "replace-section": "A" }, "x", "markdown")).toEqual({ kind: "replaceSection", section: "A", body: { value: "x", format: "markdown" } });
    expect(editOperation({ ...flags, find: "a", replace: "" }, undefined, "markdown")).toEqual({ kind: "findReplace", find: "a", replace: "", all: false });
    expect(editOperation({ ...flags }, "<p/>", "storage")).toEqual({ kind: "replaceBody", body: { value: "<p/>", format: "storage" } });
    expect(editOperation({ ...flags, title: "T" }, undefined, "markdown")).toBeUndefined();
  });

  it("rejects ambiguous or incomplete combinations", () => {
    expect(usage(() => editOperation({ ...flags, append: true, prepend: true }, "x", "markdown"))).toContain("one of");
    expect(usage(() => editOperation({ ...flags, find: "a" }, undefined, "markdown"))).toContain("--replace");
    expect(usage(() => editOperation({ ...flags, find: "", replace: "b" }, undefined, "markdown"))).toContain("empty");
    expect(usage(() => editOperation({ ...flags, all: true }, "x", "markdown"))).toContain("--all needs --find");
    expect(usage(() => editOperation({ ...flags, append: true }, undefined, "markdown"))).toContain("needs --body");
    expect(usage(() => editOperation({ ...flags, append: true }, "x", "storage"))).toContain("storage");
  });
});

describe("error serializer", () => {
  it("keeps details for field errors, hints for config errors, and exit codes 1, 2, and 3", () => {
    const conflict = new AtlassianFieldError("stale", "version_conflict", { expected: 5, current: 7 });
    expect(errorPayload(conflict)).toMatchObject({ status: "error", code: "version_conflict", details: { expected: 5, current: 7 } });
    expect(exitCodeFor(conflict)).toBe(1);
    const config = new AtlassianConfigError("no keychain", "run auth set", "locked");
    expect(errorPayload(config)).toMatchObject({ code: "config_error", hint: "run auth set", reason: "locked" });
    expect(exitCodeFor(config)).toBe(3);
    expect(exitCodeFor(new UsageError("bad"))).toBe(2);
  });
});

describe("confluence commands without credentials", () => {
  it("returns usage errors as JSON with exit 2 before any request", async () => {
    const search = await runCli(["confluence", "search", "--json"]);
    expect(search.code).toBe(2);
    expect(JSON.parse(search.stdout)).toMatchObject({ status: "error", code: "usage_error", message: "Pass exactly one of --cql or --text" });

    const edit = await runCli(["confluence", "edit", "1", "--append", "--prepend", "--body", "x", "--json"]);
    expect(edit.code).toBe(2);
    expect(JSON.parse(edit.stdout).code).toBe("usage_error");

    const create = await runCli(["confluence", "create", "--title", "x", "--json"]);
    expect(create.code).toBe(2);
  });
});
