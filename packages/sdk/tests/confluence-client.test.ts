import { afterEach, describe, expect, it } from "bun:test";
import type { AdfNode } from "../src/adf.js";
import { AtlassianClient } from "../src/client.js";
import type { AtlassianFieldError } from "../src/errors.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client(): AtlassianClient {
  return new AtlassianClient({ siteUrl: "https://example.atlassian.net", email: "user@example.com", apiToken: "test-token" });
}

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
}

type Reply = { status?: number; body?: unknown } | Error;
type Route = (call: Call) => Reply | undefined;

function stub(...routes: Route[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: new URL(String(input)), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    for (const route of routes) {
      const reply = route(call);
      if (reply === undefined) continue;
      if (reply instanceof Error) throw reply;
      if (reply.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: `unrouted ${call.method} ${call.url.pathname}` }), { status: 500 });
  }) as typeof fetch;
  return calls;
}

const t = (text: string): AdfNode => ({ type: "text", text });
const p = (text: string): AdfNode => ({ type: "paragraph", content: [t(text)] });
const h = (level: number, text: string): AdfNode => ({ type: "heading", attrs: { level }, content: [t(text)] });
const macro: AdfNode = { type: "extension", attrs: { extensionKey: "toc", extensionType: "com.atlassian.confluence.macro.core" } };

function pageJson(opts: { id?: string; version?: number; status?: string; content?: AdfNode[]; storage?: string; title?: string } = {}) {
  const content = opts.content ?? [h(1, "Intro"), p("hello"), macro, h(2, "Steps"), p("old step")];
  return {
    id: opts.id ?? "100",
    status: opts.status ?? "current",
    title: opts.title ?? "Synthetic Page",
    spaceId: "777",
    parentId: "90",
    version: { number: opts.version ?? 5 },
    body: {
      atlas_doc_format: { representation: "atlas_doc_format", value: JSON.stringify({ type: "doc", version: 1, content }) },
      ...(opts.storage !== undefined ? { storage: { representation: "storage", value: opts.storage } } : {}),
    },
    _links: { webui: `/spaces/SYN/pages/${opts.id ?? "100"}/Synthetic+Page`, base: "https://example.atlassian.net/wiki" },
  };
}

const space: Route = (call) => (call.url.pathname === "/wiki/api/v2/spaces/777" ? { body: { id: "777", key: "SYN", name: "Synthetic" } } : undefined);
const editorV2: Route = (call) => (call.url.pathname.endsWith("/properties") ? { body: { results: [{ key: "editor", value: "v2" }] } } : undefined);
const noDraft: Route = (call) => (call.url.searchParams.get("get-draft") === "true" ? { body: { ...pageJson(), status: "current" } } : undefined);

function page(json: ReturnType<typeof pageJson>): Route {
  return (call) =>
    call.method === "GET" && call.url.pathname === `/wiki/api/v2/pages/${json.id}` && call.url.searchParams.get("get-draft") !== "true" ? { body: json } : undefined;
}

async function failure(promise: Promise<unknown>): Promise<AtlassianFieldError> {
  try {
    await promise;
  } catch (err) {
    return err as AtlassianFieldError;
  }
  throw new Error("expected a failure");
}

describe("getConfluencePageContent", () => {
  it("returns metadata, one url, the markdown body, and the lossy report", async () => {
    const calls = stub(page(pageJson()), space);
    const result = await client().getConfluencePageContent("100");
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("atlas_doc_format");
    expect(result).toMatchObject({
      id: "100",
      title: "Synthetic Page",
      space: { id: "777", key: "SYN" },
      status: "current",
      version: 5,
      parentId: "90",
      url: "https://example.atlassian.net/wiki/spaces/SYN/pages/100/Synthetic+Page",
      body: "# Intro\n\nhello\n\n[[cf:macro toc]]\n\n## Steps\n\nold step",
      lossy: [{ kind: "macro", count: 1, details: ["toc"], dropped: false }],
    });
  });

  it("returns the outline instead of the body over the size guard, and the body with full", async () => {
    const big = pageJson({ content: [h(1, "Big"), p("x".repeat(13_000)), h(2, "Small"), p("y")] });
    stub(page(big), space);
    const guarded = await client().getConfluencePageContent("100");
    expect(guarded.body).toBeUndefined();
    expect(guarded.guard?.hint).toContain('use --section "<heading>" or --full');
    expect(guarded.outline?.sections.map((section) => section.selector)).toEqual(["Big", "Small"]);
    const full = await client().getConfluencePageContent("100", { full: true });
    expect(String(full.body).length).toBeGreaterThan(13_000);
  });

  it("returns only the requested sections", async () => {
    stub(page(pageJson()), space);
    const result = await client().getConfluencePageContent("100", { sections: ["steps"] });
    expect(result.body).toBeUndefined();
    expect(result.sections).toEqual([{ selector: "Steps", chars: "## Steps\n\nold step".length, body: "## Steps\n\nold step" }]);
  });

  it("returns raw storage, reads drafts, and skips the body for meta", async () => {
    const json = pageJson({ storage: "<p>raw</p>" });
    const calls = stub((call) => (call.url.pathname === "/wiki/api/v2/pages/100" ? { body: json } : undefined), space);
    expect((await client().getConfluencePageContent("100", { format: "storage", draft: true })).body).toBe("<p>raw</p>");
    expect(calls[0]?.url.searchParams.get("body-format")).toBe("storage");
    expect(calls[0]?.url.searchParams.get("get-draft")).toBe("true");
    const meta = await client().getConfluencePageContent("100", { meta: true });
    expect(meta.body).toBeUndefined();
    expect(calls.at(-1)?.url.searchParams.get("body-format")).toBeNull();
  });
});

describe("searchConfluence", () => {
  const hit = (id: string, title: string, excerpt: string, key = "SYN") => ({
    content: { id, type: "page", status: "current", title, space: { key }, version: { number: 3 }, ancestors: [{ id: "1", title: "Root" }], _links: { webui: `/spaces/${key}/pages/${id}` } },
    title,
    excerpt,
    url: `/spaces/${key}/pages/${id}`,
    lastModified: "2026-10-01T12:34:56.000Z",
    friendlyLastModified: "Oct 01, 2026",
    iconCssClass: "aui-icon content-type-page",
    entityType: "content",
  });

  it("builds CQL from text, pages by cursor, cleans and cuts excerpts", async () => {
    const calls = stub((call) =>
      call.url.pathname === "/wiki/rest/api/search"
        ? {
            body: {
              results: [hit("1", "@@@hl@@@Release@@@endhl@@@ Process", `Steps for cutting a @@@hl@@@release@@@endhl@@@ &amp; tagging the build, then posting notes to the channel and updating the changelog for everyone`)],
              totalSize: 143,
              size: 1,
              _links: { base: "https://example.atlassian.net/wiki", next: "/rest/api/search?cql=x&limit=10&cursor=abc%3D" },
            },
          }
        : undefined
    );
    const result = await client().searchConfluence({ text: 'say "hi"', space: "SYN" });
    expect(calls[0]?.url.searchParams.get("cql")).toBe('siteSearch ~ "say \\"hi\\"" AND space = "SYN" AND type = page');
    expect(calls[0]?.url.searchParams.get("limit")).toBe("10");
    expect(result).toMatchObject({ count: 1, total: 143, isLast: false, nextCursor: "abc=" });
    expect(result.results[0]).toEqual({
      id: "1",
      title: "Release Process",
      space: "SYN",
      type: "page",
      modified: "2026-10-01",
      excerpt: "Steps for cutting a release & tagging the build, then posting notes to the channel and…",
    });
  });

  it("selects fields, keeps one url, and asks for no excerpt with none", async () => {
    const calls = stub((call) => (call.url.pathname === "/wiki/rest/api/search" ? { body: { results: [hit("2", "T", "e")], _links: { base: "https://example.atlassian.net/wiki" } } } : undefined));
    const result = await client().searchConfluence({ cql: "type = page", fields: ["id", "url", "version", "ancestors"], excerpt: "none", cursor: "c1" });
    expect(calls[0]?.url.searchParams.get("excerpt")).toBe("none");
    expect(calls[0]?.url.searchParams.get("cursor")).toBe("c1");
    expect(calls[0]?.url.searchParams.get("expand")).toBe("content.space,content.version,content.ancestors");
    expect(result.isLast).toBe(true);
    expect(result.results[0]).toEqual({ id: "2", url: "https://example.atlassian.net/wiki/spaces/SYN/pages/2", version: 3, ancestors: [{ id: "1", title: "Root" }] });
  });

  it("reports bad CQL as invalid_cql and refuses cql with text", async () => {
    stub((call) => (call.url.pathname === "/wiki/rest/api/search" ? { status: 400, body: { message: "Could not parse cql" } } : undefined));
    expect((await failure(client().searchConfluence({ cql: "type ==" }))).code).toBe("invalid_cql");
    expect((await failure(client().searchConfluence({ cql: "a", text: "b" }))).code).toBe("invalid_request");
  });
});

describe("createConfluencePage", () => {
  const parent = pageJson({ id: "90", title: "Parent Page" });
  const noDuplicate: Route = (call) => (call.url.pathname === "/wiki/rest/api/search" ? { body: { results: [] } } : undefined);
  const created: Route = (call) =>
    call.method === "POST" && call.url.pathname === "/wiki/api/v2/pages" ? { body: { id: "200", status: (call.body as { status: string }).status, title: "New", version: { number: 1 }, _links: { webui: "/spaces/SYN/pages/200", base: "https://example.atlassian.net/wiki" } } } : undefined;

  it("takes the space from the parent and sends markdown as ADF", async () => {
    const calls = stub(page(parent), space, noDuplicate, created);
    const result = await client().createConfluencePage({ title: "New", parentId: "90", body: { value: "# Hi\n\n- [ ] task" } });
    const post = calls.find((call) => call.method === "POST");
    const body = post?.body as { spaceId: string; parentId: string; status: string; body: { representation: string; value: string } };
    expect(body).toMatchObject({ spaceId: "777", parentId: "90", status: "current", title: "New" });
    expect(body.body.representation).toBe("atlas_doc_format");
    expect(JSON.parse(body.body.value).content.map((node: AdfNode) => node.type)).toEqual(["heading", "taskList"]);
    expect(result).toEqual(expect.objectContaining({ status: "created", id: "200", version: 1, pageStatus: "current", url: "https://example.atlassian.net/wiki/spaces/SYN/pages/200" }));
    expect(calls.find((call) => call.url.pathname === "/wiki/rest/api/search")?.url.searchParams.get("cql")).toBe('space = "SYN" AND type = page AND title = "New"');
  });

  it("sends storage and ADF bodies as given, and drafts with status draft", async () => {
    const calls = stub(
      (call) => (call.url.pathname === "/wiki/api/v2/spaces" ? { body: { results: [{ id: "777", key: "SYN" }] } } : undefined),
      noDuplicate,
      created
    );
    await client().createConfluencePage({ title: "S", space: "SYN", body: { value: "<p>x</p>", format: "storage" }, draft: true });
    await client().createConfluencePage({ title: "A", space: "SYN", body: { value: '{"type":"doc","version":1,"content":[]}', format: "adf" } });
    const posts = calls.filter((call) => call.method === "POST").map((call) => call.body as { status: string; body: { representation: string; value: string } });
    expect(posts[0]).toMatchObject({ status: "draft", body: { representation: "storage", value: "<p>x</p>" } });
    expect(posts[1]).toMatchObject({ status: "current", body: { representation: "atlas_doc_format", value: '{"type":"doc","version":1,"content":[]}' } });
  });

  it("dry run reports placement, ancestors, and body size without writing", async () => {
    const calls = stub(
      page(parent),
      page(pageJson({ id: "1", title: "Root" })),
      space,
      noDuplicate,
      (call) => (call.url.pathname === "/wiki/api/v2/pages/90/ancestors" ? { body: { results: [{ id: "1", type: "page" }] } } : undefined)
    );
    const result = await client().createConfluencePage({ title: "New", parentId: "90", body: { value: "hello" } }, { dryRun: true });
    expect(result).toMatchObject({ status: "dry_run", space: { key: "SYN" }, parent: { id: "90", title: "Parent Page", ancestors: [{ id: "1", title: "Root" }] }, bodyChars: 5 });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("maps each failure to its own code", async () => {
    stub(page(parent), space, (call) => (call.url.pathname === "/wiki/rest/api/search" ? { body: { results: [{ content: { id: "5", title: "New" }, title: "New" }] } } : undefined));
    expect((await failure(client().createConfluencePage({ title: "new", parentId: "90", body: { value: "x" } }))).code).toBe("title_exists");

    stub((call) => (call.url.pathname === "/wiki/api/v2/pages/404" ? { status: 404, body: { message: "Not found" } } : undefined));
    const missingParent = await failure(client().createConfluencePage({ title: "x", parentId: "404", body: { value: "x" } }));
    expect(missingParent.code).toBe("parent_not_found");
    expect(missingParent.message).toContain("missing or not visible");

    stub((call) => (call.url.pathname === "/wiki/api/v2/spaces" ? { body: { results: [] } } : undefined));
    expect((await failure(client().createConfluencePage({ title: "x", space: "NOPE", body: { value: "x" } }))).code).toBe("space_not_found");

    stub(page(parent), space, noDuplicate, (call) => (call.method === "POST" ? { status: 404, body: { message: "Not found" } } : undefined));
    expect((await failure(client().createConfluencePage({ title: "x", parentId: "90", body: { value: "x" } }))).code).toBe("permission_denied");

    stub(page(parent), space, noDuplicate, (call) => (call.method === "POST" ? { status: 403, body: { message: "Forbidden" } } : undefined));
    expect((await failure(client().createConfluencePage({ title: "x", parentId: "90", body: { value: "x" } }))).code).toBe("permission_denied");

    stub(page(parent), space, noDuplicate, (call) => (call.method === "POST" ? { status: 413, body: {} } : undefined));
    expect((await failure(client().createConfluencePage({ title: "x", parentId: "90", body: { value: "x" } }))).code).toBe("body_too_large");

    stub(page(parent), space, noDuplicate, (call) => (call.method === "POST" ? { status: 400, body: { message: "A page with this title already exists" } } : undefined));
    expect((await failure(client().createConfluencePage({ title: "x", parentId: "90", body: { value: "x" } }))).code).toBe("title_exists");

    expect((await failure(client().createConfluencePage({ title: "x", parentId: "90", body: { value: "[[cf:macro toc]]" } }))).code).toBe("placeholder_in_body");
  });

  it("reports a label failure with the created page so it is not created twice", async () => {
    stub(page(parent), space, noDuplicate, created, (call) => (call.url.pathname.endsWith("/label") ? { status: 400, body: { message: "Invalid label" } } : undefined));
    const result = await client().createConfluencePage({ title: "New", parentId: "90", body: { value: "x" }, labels: ["ok", "bad label"] });
    expect(result).toMatchObject({ status: "created_with_errors", id: "200", failedLabels: ["ok", "bad label"] });
  });

  it("adds labels with one v1 call", async () => {
    const calls = stub(page(parent), space, noDuplicate, created, (call) => (call.url.pathname.endsWith("/label") ? { body: { results: [] } } : undefined));
    await client().createConfluencePage({ title: "New", parentId: "90", body: { value: "x" }, labels: ["alpha"] });
    expect(calls.find((call) => call.url.pathname.endsWith("/label"))?.body).toEqual([{ prefix: "global", name: "alpha" }]);
  });
});

describe("editConfluencePage", () => {
  function putRoute(reply: (call: Call) => Reply): Route {
    return (call) => (call.method === "PUT" && call.url.pathname === "/wiki/api/v2/pages/100" ? reply(call) : undefined);
  }
  const ok = putRoute((call) => ({ body: { ...pageJson(), version: { number: (call.body as { version: { number: number } }).version.number } } }));

  it("replaces a section, keeps the macro untouched, and writes version + 1 with the message", async () => {
    const calls = stub(page(pageJson()), editorV2, noDraft, ok);
    const result = await client().editConfluencePage("100", { operation: { kind: "replaceSection", section: "Steps", body: { value: "new step" } } }, { message: "tidy" });
    const put = calls.find((call) => call.method === "PUT")?.body as { version: unknown; body: { value: string } };
    expect(put.version).toEqual({ number: 6, message: "tidy" });
    const written = JSON.parse(put.body.value);
    expect(written.content[2]).toEqual(macro);
    expect(written.content.at(-1)).toEqual({ type: "paragraph", content: [{ type: "text", text: "new step" }] });
    expect(result).toMatchObject({ status: "updated", version: 6, previousVersion: 5, section: "Steps", operation: "replaceSection" });
  });

  it("dry run reports sizes and the version without writing", async () => {
    const calls = stub(page(pageJson()), editorV2, noDraft);
    const result = await client().editConfluencePage("100", { operation: { kind: "append", body: { value: "tail" } } }, { dryRun: true });
    expect(result).toMatchObject({ status: "dry_run", version: 6, operation: "append" });
    expect(result.chars?.after).toBe((result.chars?.before ?? 0) + "\n\ntail".length);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("fails before writing when the expected version is stale", async () => {
    const calls = stub(page(pageJson({ version: 7 })), editorV2, noDraft);
    const err = await failure(client().editConfluencePage("100", { operation: { kind: "replaceBody", body: { value: "x" } } }, { expectVersion: 5, allowLossy: true }));
    expect(err.code).toBe("version_conflict");
    expect(err.details).toEqual({ expected: 5, current: 7 });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("requires --expect-version for a whole-body replace", async () => {
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "replaceBody", body: { value: "x" } } }))).code).toBe("expect_version_required");
  });

  it("refuses a lossy whole-body markdown replace, and allows it with allowLossy", async () => {
    stub(page(pageJson()), editorV2, noDraft, ok);
    const err = await failure(client().editConfluencePage("100", { operation: { kind: "replaceBody", body: { value: "x" } } }, { expectVersion: 5 }));
    expect(err.code).toBe("lossy_replace");
    expect(err.details).toEqual({ lost: [{ kind: "macro", count: 1, details: ["toc"] }] });
    const allowed = await client().editConfluencePage("100", { operation: { kind: "replaceBody", body: { value: "x" } } }, { expectVersion: 5, allowLossy: true });
    expect(allowed.lossy).toEqual([{ kind: "macro", count: 1 }]);
  });

  it("refuses a section replace that would remove a macro", async () => {
    stub(page(pageJson()), editorV2, noDraft);
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "replaceSection", section: "Intro", body: { value: "x" } } }))).code).toBe("lossy_replace");
  });

  it("rejects placeholders in a body and storage bodies on targeted edits", async () => {
    stub(page(pageJson()), editorV2, noDraft);
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "append", body: { value: "[[cf:macro toc]]" } } }))).code).toBe("placeholder_in_body");
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "append", body: { value: "<p/>", format: "storage" } } }))).code).toBe("invalid_request");
  });

  it("refuses ADF writes to a legacy-editor page, but allows a storage replace", async () => {
    const calls = stub(page(pageJson({ storage: "<p>old</p>" })), noDraft, (call) => (call.url.pathname.endsWith("/properties") ? { body: { results: [] } } : undefined), ok);
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "append", body: { value: "x" } } }))).code).toBe("legacy_editor_page");
    const result = await client().editConfluencePage("100", { operation: { kind: "replaceBody", body: { value: "<p>new</p>", format: "storage" } } }, { expectVersion: 5 });
    expect(result.status).toBe("updated");
    expect((calls.find((call) => call.method === "PUT")?.body as { body: unknown }).body).toEqual({ representation: "storage", value: "<p>new</p>" });
  });

  it("warns when an unpublished draft exists", async () => {
    stub((call) => (call.url.searchParams.get("get-draft") === "true" ? { body: { ...pageJson(), status: "draft" } } : undefined), page(pageJson()), editorV2);
    const result = await client().editConfluencePage("100", { operation: { kind: "append", body: { value: "x" } } }, { dryRun: true });
    expect(result.draft).toBe("exists");
  });

  it("retries a targeted edit once when the page moved on during the write", async () => {
    let reads = 0;
    let puts = 0;
    const calls = stub(
      (call) => {
        if (call.method !== "GET" || call.url.pathname !== "/wiki/api/v2/pages/100" || call.url.searchParams.get("get-draft") === "true") return undefined;
        reads += 1;
        return { body: pageJson({ version: reads === 1 ? 5 : 6 }) };
      },
      editorV2,
      noDraft,
      putRoute(() => {
        puts += 1;
        return puts === 1 ? { status: 409, body: { message: "Version conflict" } } : { body: { ...pageJson(), version: { number: 7 } } };
      })
    );
    const result = await client().editConfluencePage("100", { operation: { kind: "findReplace", find: "old step", replace: "new step" } });
    expect(result).toMatchObject({ status: "updated", version: 7, retried: true, matches: 1 });
    expect(calls.filter((call) => call.method === "PUT").map((call) => (call.body as { version: { number: number } }).version.number)).toEqual([6, 7]);
  });

  it("never retries a section replace or an edit with an explicit expected version", async () => {
    let reads = 0;
    const moving: Route = (call) => {
      if (call.method !== "GET" || call.url.pathname !== "/wiki/api/v2/pages/100" || call.url.searchParams.get("get-draft") === "true") return undefined;
      reads += 1;
      return { body: pageJson({ version: reads === 1 ? 5 : 6 }) };
    };
    const conflict = putRoute(() => ({ status: 409, body: { message: "Version conflict" } }));
    let calls = stub(moving, editorV2, noDraft, conflict);
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "replaceSection", section: "Steps", body: { value: "x" } } }))).code).toBe("version_conflict");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);

    reads = 0;
    calls = stub(moving, editorV2, noDraft, conflict);
    const err = await failure(client().editConfluencePage("100", { operation: { kind: "append", body: { value: "x" } } }, { expectVersion: 5 }));
    expect(err.code).toBe("version_conflict");
    expect(err.details).toEqual({ expected: 5, current: 6 });
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("classifies a 409 without a version change as approval_required or write_rejected", async () => {
    stub(page(pageJson()), editorV2, noDraft, putRoute(() => ({ status: 409, body: { message: "Content approval is required before publishing" } })));
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "append", body: { value: "x" } } }))).code).toBe("approval_required");
    stub(page(pageJson()), editorV2, noDraft, putRoute(() => ({ status: 409, body: { message: "Something else" } })));
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "append", body: { value: "x" } } }))).code).toBe("write_rejected");
  });

  it("reports a network failure during the write as write_outcome_unknown, without retrying", async () => {
    const calls = stub(page(pageJson()), editorV2, noDraft, putRoute(() => new TypeError("socket hang up")));
    expect((await failure(client().editConfluencePage("100", { operation: { kind: "append", body: { value: "x" } } }))).code).toBe("write_outcome_unknown");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("renames through the title endpoint, and through a versioned PUT when a version is expected", async () => {
    const calls = stub(page(pageJson()), noDraft, editorV2, ok, (call) =>
      call.method === "PUT" && call.url.pathname.endsWith("/title") ? { body: { ...pageJson({ title: "Renamed" }), version: { number: 6 } } } : undefined
    );
    const quick = await client().editConfluencePage("100", { title: "Renamed" });
    expect(quick).toMatchObject({ status: "updated", operation: "title", version: 6 });
    expect(calls.find((call) => call.url.pathname.endsWith("/title"))?.body).toEqual({ status: "current", title: "Renamed" });

    const guarded = await client().editConfluencePage("100", { title: "Renamed" }, { expectVersion: 5 });
    expect(guarded).toMatchObject({ status: "updated", title: "Renamed", version: 6 });
    const put = calls.find((call) => call.method === "PUT" && call.url.pathname === "/wiki/api/v2/pages/100")?.body as { title: string; body: { value: string } };
    expect(put.title).toBe("Renamed");
    expect(JSON.parse(put.body.value).content[2]).toEqual(macro);
  });
});
