import { describe, expect, it } from "bun:test";
import { type AdfNode, markdownToAdf } from "../src/adf.js";
import { adfOutline, adfToMarkdown, containsConfluencePlaceholder, findAdfSection, listAdfSections } from "../src/adf-markdown.js";
import { AtlassianFieldError } from "../src/errors.js";

/** Drops generated ids, which a write mints fresh and a comparison should ignore. */
function stripIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIds);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "localId") continue;
    const stripped = stripIds(inner);
    if (key === "attrs" && typeof stripped === "object" && stripped !== null && Object.keys(stripped).length === 0) continue;
    out[key] = stripped;
  }
  return out;
}

function roundTrip(markdown: string): string {
  return adfToMarkdown(markdownToAdf(markdown)).markdown;
}

const doc = (...content: AdfNode[]) => ({ type: "doc" as const, version: 1 as const, content });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: Array<{ type: string; attrs?: Record<string, unknown> }>): AdfNode => (marks.length > 0 ? { type: "text", text, marks } : { type: "text", text });
const h = (level: number, text: string): AdfNode => ({ type: "heading", attrs: { level }, content: [t(text)] });

describe("markdown round trip for every supported construct", () => {
  const cases: Record<string, string> = {
    headings: "# One\n\n## Two\n\n###### Six",
    paragraph: "First line\nsecond line\n\nNext paragraph",
    marks: "A **bold**, *em*, ~~gone~~, `code`, and [docs](https://example.dev/a_(b)) here.",
    escapes: "Literal \\*\\*not bold\\*\\*, \\`tick\\`, a \\_word\\_, snake_case, C:\\Temp, and \\\\\\*",
    "bullet list": "- one\n- two\n  - nested\n  - nested two\n- three",
    "ordered list": "3. three\n4. four\n   - mixed child",
    "task list": "- [ ] todo\n- [x] done\n  - [ ] nested",
    code: "```ts\nconst a = `x`;\n```",
    "code with fence inside": "````md\n```\ninner\n```\n````",
    quote: "> quoted\n> lines",
    rule: "Above\n\n---\n\nBelow",
    table: "| Name | Value |\n| --- | --- |\n| a \\| b | **x** |\n| c | [l](https://e.dev) |",
    "line-start literals": "\\# not a heading\n\\- not a list\n1\\. not ordered\n\\> not a quote",
  };

  for (const [name, markdown] of Object.entries(cases)) {
    it(name, () => {
      const once = roundTrip(markdown);
      expect(once).toBe(markdown);
      expect(adfToMarkdown(markdownToAdf(once)).lossy).toEqual([]);
    });
  }

  it("keeps blocks after a list as top-level siblings (regression on the Confluence path)", () => {
    const markdown = "- one\n- two\n\nA paragraph after the list.\n\n**Label:** value";
    const adf = markdownToAdf(markdown);
    expect(adf.content.map((node) => node.type)).toEqual(["bulletList", "paragraph", "paragraph"]);
    expect(roundTrip(markdown)).toBe(markdown);
  });
});

describe("ADF round trip from Confluence-authored content", () => {
  it("reads literal markdown characters as plain text, not markup", () => {
    const source = doc(p(t("Use **urgent** and `ticks` and [x](y) and 2 * 3 literally")));
    const read = adfToMarkdown(source);
    expect(stripIds(markdownToAdf(read.markdown))).toEqual(stripIds(source));
    expect(read.lossy).toEqual([]);
  });

  it("round-trips task items, ignoring generated ids", () => {
    const source = doc({
      type: "taskList",
      attrs: { localId: "a" },
      content: [
        { type: "taskItem", attrs: { localId: "b", state: "TODO" }, content: [t("write it")] },
        { type: "taskItem", attrs: { localId: "c", state: "DONE" }, content: [t("ship", { type: "strong" }), t(" it")] },
      ],
    });
    expect(stripIds(markdownToAdf(adfToMarkdown(source).markdown))).toEqual(stripIds(source));
  });

  it("reports linked bold text as nested formatting rather than losing it silently", () => {
    const read = adfToMarkdown(doc(p(t("docs", { type: "strong" }, { type: "link", attrs: { href: "https://e.dev" } }))));
    expect(read.markdown).toBe("[docs](https://e.dev)");
    expect(read.lossy).toEqual([{ kind: "nested formatting", count: 1, dropped: true }]);
  });

  it("reports unknown marks, colour, underline, alignment, and inline comments", () => {
    const read = adfToMarkdown(
      doc(
        { type: "paragraph", marks: [{ type: "alignment", attrs: { align: "center" } }], content: [t("centred")] },
        p(t("red", { type: "textColor", attrs: { color: "#f00" } }), t(" under", { type: "underline" }), t(" noted", { type: "annotation", attrs: { id: "x" } }), t(" odd", { type: "sparkle" }))
      )
    );
    expect(read.markdown).toBe("centred\n\nred under noted odd");
    expect(read.lossy.map((item) => item.kind)).toEqual(["alignment", "inline comment", "sparkle", "text colour", "underline"]);
    expect(read.lossy.every((item) => item.dropped)).toBe(true);
  });

  it("reports table layout and header differences, and keeps simple table content", () => {
    const cell = (type: string, text: string, attrs: Record<string, unknown> = {}): AdfNode => ({ type, attrs, content: [p(t(text))] });
    const read = adfToMarkdown(
      doc({
        type: "table",
        attrs: { layout: "wide", width: 900 },
        content: [
          { type: "tableRow", content: [cell("tableCell", "a", { colwidth: [120] }), cell("tableCell", "b")] },
          { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
        ],
      })
    );
    expect(read.markdown).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(read.lossy.map((item) => item.kind)).toEqual(["table header", "table layout"]);
  });

  it("flattens a table with merged cells and counts it as lossy", () => {
    const read = adfToMarkdown(
      doc({
        type: "table",
        content: [
          { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [p(t("wide"))] }] },
          { type: "tableRow", content: [{ type: "tableCell", content: [p(t("x")), p(t("y"))] }, { type: "tableCell", content: [p(t("z"))] }] },
        ],
      })
    );
    expect(read.markdown).toContain("| x / y | z |");
    expect(read.lossy).toContainEqual({ kind: "table", count: 1, details: ["merged cells or blocks in cells"], dropped: false });
  });
});

describe("placeholders and markers", () => {
  const page = doc(
    h(1, "Overview"),
    { type: "extension", attrs: { extensionKey: "toc", extensionType: "com.atlassian.confluence.macro.core" } },
    p(t("Owner: "), { type: "mention", attrs: { id: "abc", text: "@Ada Lovelace" } }, t(" "), { type: "status", attrs: { text: "DONE" } }, t(" "), { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } }),
    { type: "panel", attrs: { panelType: "info" }, content: [p(t("Deploys freeze at 16:00."))] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", type: "file", collection: "c", alt: "diagram.png" } }] },
    { type: "expand", attrs: { title: "Details" }, content: [p(t("Hidden text"))] },
    { type: "bodiedExtension", attrs: { extensionKey: "details" }, content: [p(t("Inside a macro"))] },
    p({ type: "inlineCard", attrs: { url: "https://e.dev/card" } }, { type: "date", attrs: { timestamp: "1767225600000" } })
  );

  it("renders each kind visibly and reports it", () => {
    const read = adfToMarkdown(page);
    expect(read.markdown).toBe(
      [
        "# Overview",
        "[[cf:macro toc]]",
        "Owner: [[cf:mention @Ada Lovelace]] [[cf:status DONE]] 😄",
        "[[cf:panel info]]\nDeploys freeze at 16:00.\n[[/cf:panel]]",
        "[[cf:image diagram.png]]",
        "[[cf:expand Details]]\nHidden text\n[[/cf:expand]]",
        "[[cf:macro details]]\nInside a macro\n[[/cf:macro]]",
        "[https://e.dev/card](https://e.dev/card)[[cf:date 2026-01-01]]",
      ].join("\n\n")
    );
    expect(read.lossy).toEqual([
      { kind: "date", count: 1, dropped: false },
      { kind: "emoji", count: 1, dropped: true },
      { kind: "expand", count: 1, dropped: false },
      { kind: "image", count: 1, dropped: false },
      { kind: "macro", count: 2, details: ["details", "toc"], dropped: false },
      { kind: "mention", count: 1, dropped: false },
      { kind: "panel", count: 1, details: ["info"], dropped: false },
      { kind: "smart link", count: 1, dropped: true },
      { kind: "status", count: 1, dropped: false },
    ]);
    expect(containsConfluencePlaceholder(read.markdown)).toBe(true);
  });

  it("does not treat escaped brackets in page text as a placeholder", () => {
    const read = adfToMarkdown(doc(p(t("literal [[cf:macro x]] text"))));
    expect(containsConfluencePlaceholder(read.markdown)).toBe(false);
    expect(stripIds(markdownToAdf(read.markdown))).toEqual(stripIds(doc(p(t("literal [[cf:macro x]] text")))));
  });

  it("shows layout columns with their content", () => {
    const read = adfToMarkdown(
      doc({
        type: "layoutSection",
        content: [
          { type: "layoutColumn", attrs: { width: 50 }, content: [h(2, "Left"), p(t("l"))] },
          { type: "layoutColumn", attrs: { width: 50 }, content: [p(t("r"))] },
        ],
      })
    );
    expect(read.markdown).toBe("[[cf:layout 50%]]\n## Left\n\nl\n[[/cf:layout]]\n\n[[cf:layout 50%]]\nr\n[[/cf:layout]]");
    expect(read.lossy).toEqual([{ kind: "layout", count: 1, dropped: false }]);
  });
});

describe("sections, selectors, and outline", () => {
  const page = doc(
    p(t("intro")),
    h(1, "Setup"),
    p(t("setup text")),
    h(2, "Install"),
    p(t("install a")),
    h(3, "Deep"),
    p(t("deep text")),
    h(2, "Configure"),
    h(1, "Usage"),
    h(2, "Install"),
    p(t("install b")),
    h(1, "Setup"),
    h(2, "Install"),
    { type: "layoutSection", content: [{ type: "layoutColumn", content: [h(2, "Column heading"), p(t("in column"))] }] }
  );

  it("ends a section at the next heading of the same or a higher level", () => {
    const section = findAdfSection(page, "Usage > Install");
    expect(adfToMarkdown(section.container.slice(section.start, section.end)).markdown).toBe("## Install\n\ninstall b");
    const setup = findAdfSection(page, "Setup > Install [1]");
    expect(adfToMarkdown(setup.container.slice(setup.start, setup.end)).markdown).toBe("## Install\n\ninstall a\n\n### Deep\n\ndeep text");
  });

  it("gives every section a selector that resolves back to it alone", () => {
    const sections = listAdfSections(page);
    expect(sections.map((section) => section.selector)).toEqual([
      "Setup [1]",
      "Setup > Install [1]",
      "Deep",
      "Configure",
      "Usage",
      "Usage > Install",
      "Setup [2]",
      "Setup > Install [2]",
      "Column heading",
    ]);
    for (const section of sections) expect(findAdfSection(page, section.selector).start).toBe(section.start);
  });

  it("finds a heading inside a layout column", () => {
    const section = findAdfSection(page, "column heading");
    expect(adfToMarkdown(section.container.slice(section.start, section.end)).markdown).toBe("## Column heading\n\nin column");
  });

  it("fails on a missing heading with the available selectors", () => {
    try {
      findAdfSection(page, "Nope");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("section_not_found");
      expect((err as AtlassianFieldError).details).toMatchObject({ available: expect.arrayContaining(["Usage", "Deep"]) });
    }
  });

  it("fails on a duplicate heading with exact selectors to retry with", () => {
    try {
      findAdfSection(page, "Install");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("section_ambiguous");
      expect((err as AtlassianFieldError).details).toEqual({ section: "Install", candidates: ["Setup > Install [1]", "Usage > Install", "Setup > Install [2]"] });
    }
  });

  it("sizes the intro and each section in markdown characters", () => {
    const outline = adfOutline(page);
    expect(outline.intro).toBe("intro".length);
    expect(outline.sections.find((section) => section.selector === "Usage > Install")?.chars).toBe("## Install\n\ninstall b".length);
  });
});
