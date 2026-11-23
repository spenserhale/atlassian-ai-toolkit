import { describe, expect, it } from "bun:test";
import { type AdfDocument, type AdfNode, markdownToAdf } from "../src/adf.js";
import { adfToMarkdown } from "../src/adf-markdown.js";
import { appendAdfBlocks, findReplaceAdf, lossyReplaced, prependAdfBlocks, replaceAdfSection } from "../src/confluence-edit.js";
import { AtlassianFieldError } from "../src/errors.js";

const t = (text: string, ...marks: Array<{ type: string }>): AdfNode => (marks.length > 0 ? { type: "text", text, marks } : { type: "text", text });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const h = (level: number, text: string): AdfNode => ({ type: "heading", attrs: { level }, content: [t(text)] });
const macro: AdfNode = { type: "extension", attrs: { extensionKey: "jira", extensionType: "com.atlassian.confluence.macro.core", parameters: { macroParams: { key: { value: "X-1" } } } } };

function page(): AdfDocument {
  return {
    type: "doc",
    version: 1,
    content: [h(1, "Intro"), p(t("hello")), macro, h(2, "Details"), p(t("old detail")), h(3, "Deep"), p(t("deep")), h(2, "Other"), p(t("keep")), h(2, "Other"), p(t("twin"))],
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as AtlassianFieldError).code;
  }
  return undefined;
}

describe("replaceAdfSection", () => {
  it("replaces nested headings under the section and stops at the next heading of the same level", () => {
    const result = replaceAdfSection(page(), "Details", markdownToAdf("new detail").content);
    expect(adfToMarkdown(result.doc).markdown).toBe("# Intro\n\nhello\n\n[[cf:macro jira]]\n\n## Details\n\nnew detail\n\n## Other\n\nkeep\n\n## Other\n\ntwin");
    expect(result.removed.map((node) => node.type)).toEqual(["paragraph", "heading", "paragraph"]);
  });

  it("leaves nodes outside the section byte-for-byte as stored", () => {
    const before = page();
    const result = replaceAdfSection(before, "Details", markdownToAdf("x").content);
    expect(result.doc.content[2]).toEqual(macro);
    expect(before.content[4]).toEqual(p(t("old detail")));
  });

  it("does not duplicate the heading when the replacement repeats it", () => {
    const result = replaceAdfSection(page(), "Deep", markdownToAdf("### Deep\n\nreplaced").content);
    expect(adfToMarkdown(result.doc).markdown).toContain("### Deep\n\nreplaced\n\n## Other");
  });

  it("reports what a section replace would lose", () => {
    const result = replaceAdfSection(page(), "Intro", markdownToAdf("short").content);
    expect(lossyReplaced(result.removed)).toEqual([{ kind: "macro", count: 1, details: ["jira"], dropped: false }]);
  });

  it("fails on a missing heading and on a duplicate heading", () => {
    expect(code(() => replaceAdfSection(page(), "Absent", []))).toBe("section_not_found");
    expect(code(() => replaceAdfSection(page(), "Other", []))).toBe("section_ambiguous");
    expect(adfToMarkdown(replaceAdfSection(page(), "Other [2]", markdownToAdf("second").content).doc).markdown).toEndWith("## Other\n\nkeep\n\n## Other\n\nsecond");
  });
});

describe("append and prepend", () => {
  it("adds blocks at the end or the start", () => {
    expect(appendAdfBlocks(page(), [p(t("tail"))]).content.at(-1)).toEqual(p(t("tail")));
    expect(prependAdfBlocks(page(), [p(t("head"))]).content[0]).toEqual(p(t("head")));
  });
});

describe("findReplaceAdf", () => {
  const doc: AdfDocument = {
    type: "doc",
    version: 1,
    content: [p(t("Ship "), t("v1", { type: "strong" }), t(".0 today")), p(t("v1.0 again")), { type: "codeBlock", content: [t("echo v1.0")] }],
  };

  it("fails on zero matches, with or without --all", () => {
    expect(code(() => findReplaceAdf(doc, "v9", "x"))).toBe("no_match");
    expect(code(() => findReplaceAdf(doc, "v9", "x", true))).toBe("no_match");
  });

  it("fails on many matches without --all and reports the count", () => {
    try {
      findReplaceAdf(doc, "v1.0", "v2.0");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("multiple_matches");
      expect((err as AtlassianFieldError).details).toEqual({ find: "v1.0", matches: 3 });
    }
  });

  it("replaces one match across a bold boundary, taking the first character's marks", () => {
    const result = findReplaceAdf(doc, "Ship v1.0 today", "Shipped");
    expect(result.matches).toBe(1);
    expect(result.doc.content[0]).toEqual(p(t("Shipped")));
  });

  it("replaces every match with --all, code blocks included", () => {
    const result = findReplaceAdf(doc, "v1.0", "v2.0", true);
    expect(result.matches).toBe(3);
    expect(adfToMarkdown(result.doc).markdown).toBe("Ship **v2.0** today\n\nv2.0 again\n\n```\necho v2.0\n```");
  });

  it("does not match across a mention", () => {
    const withMention: AdfDocument = { type: "doc", version: 1, content: [p(t("hi "), { type: "mention", attrs: { text: "@Ada" } }, t(" there"))] };
    expect(code(() => findReplaceAdf(withMention, "hi  there", "x"))).toBe("no_match");
  });

  it("rejects an empty --find", () => {
    expect(code(() => findReplaceAdf(doc, "", "x"))).toBe("invalid_request");
  });
});
