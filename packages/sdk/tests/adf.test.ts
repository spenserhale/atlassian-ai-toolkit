import { describe, expect, it } from "bun:test";
import { isAdfDocument, markdownToAdf } from "../src/adf.js";

describe("markdownToAdf", () => {
  it("converts paragraphs, keeping a single newline as a hard break", () => {
    const doc = markdownToAdf("First line\nSecond line\n\nNext paragraph");

    expect(doc.version).toBe(1);
    expect(doc.content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "First line" },
          { type: "hardBreak" },
          { type: "text", text: "Second line" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "Next paragraph" }] },
    ]);
  });

  it("marks inline code, links, emphasis, and strike", () => {
    const doc = markdownToAdf("A **bold** and *soft* and `code` and ~~gone~~ and [docs](https://example.dev).");

    expect(doc.content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "A " },
        { type: "text", text: "bold", marks: [{ type: "strong" }] },
        { type: "text", text: " and " },
        { type: "text", text: "soft", marks: [{ type: "em" }] },
        { type: "text", text: " and " },
        { type: "text", text: "code", marks: [{ type: "code" }] },
        { type: "text", text: " and " },
        { type: "text", text: "gone", marks: [{ type: "strike" }] },
        { type: "text", text: " and " },
        { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.dev" } }] },
        { type: "text", text: "." },
      ],
    });
  });

  it("converts headings, rules, and fenced code with its language", () => {
    const doc = markdownToAdf("## Steps\n\n---\n\n```ts\nconst a = 1;\nconst b = 2;\n```");

    expect(doc.content[0]).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] });
    expect(doc.content[1]).toEqual({ type: "rule" });
    expect(doc.content[2]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
    });
  });

  it("nests a sublist inside its parent list item", () => {
    const doc = markdownToAdf("- one\n- two\n  - nested\n");

    expect(doc.content[0]).toMatchObject({ type: "bulletList" });
    const items = (doc.content[0] as { content: unknown[] }).content;
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      type: "listItem",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] },
      ],
    });
  });

  it("keeps an ordered list's starting number when it is not one", () => {
    const doc = markdownToAdf("3. third\n4. fourth");

    expect(doc.content[0]).toMatchObject({ type: "orderedList", attrs: { order: 3 } });
  });

  it("converts a blockquote into quoted blocks", () => {
    const doc = markdownToAdf("> quoted\n> still quoted");

    expect(doc.content[0]).toEqual({
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "quoted" },
            { type: "hardBreak" },
            { type: "text", text: "still quoted" },
          ],
        },
      ],
    });
  });

  it("gives a marker-only list item a paragraph, since ADF requires a block inside one", () => {
    const doc = markdownToAdf("- \n- two");

    expect((doc.content[0] as { content: unknown[] }).content[0]).toEqual({
      type: "listItem",
      content: [{ type: "paragraph", content: [] }],
    });
  });

  it("gives an empty blockquote a paragraph for the same reason", () => {
    expect(markdownToAdf(">").content[0]).toEqual({ type: "blockquote", content: [{ type: "paragraph", content: [] }] });
  });

  it("leaves intra-word underscores and spaced asterisks as literal text", () => {
    expect(markdownToAdf("fix the user_id_field validation").content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "fix the user_id_field validation" }],
    });
    expect(markdownToAdf("2 * 3 * 4").content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "2 * 3 * 4" }] });
  });

  it("keeps balanced parentheses inside a link href", () => {
    const doc = markdownToAdf("[x](https://en.wikipedia.org/wiki/Foo_(bar)) tail");

    expect((doc.content[0] as { content: Array<{ marks?: Array<{ attrs?: { href?: string } }> }> }).content[0]?.marks?.[0]?.attrs?.href).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)"
    );
  });

  it("takes the language from a fence that carries a longer info string", () => {
    expect(markdownToAdf("```python title=x\nprint(1)\n```").content[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "python" },
      content: [{ type: "text", text: "print(1)" }],
    });
  });

  it("yields a valid empty document for empty input, since ADF rejects an empty text node", () => {
    expect(markdownToAdf("")).toEqual({ type: "doc", version: 1, content: [{ type: "paragraph", content: [] }] });
  });
});

describe("isAdfDocument", () => {
  it("recognises a document a caller already built", () => {
    expect(isAdfDocument({ type: "doc", version: 1, content: [] })).toBe(true);
    expect(isAdfDocument("# not adf")).toBe(false);
  });
});
