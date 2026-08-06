import { afterEach, describe, expect, it } from "bun:test";
import { AtlassianClient } from "../src/client.js";
import { guessContentType } from "../src/content-type.js";

const config = {
  siteUrl: "https://example.atlassian.net",
  email: "user@example.com",
  apiToken: "test-token",
};

const originalFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("addJiraAttachments", () => {
  it("posts multipart form data with the XSRF opt-out header", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    stubFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse([{ id: "10001", filename: "notes.txt", size: 5, mimeType: "text/plain" }]);
    });

    const client = new AtlassianClient(config);
    const attachments = await client.addJiraAttachments("PROJ-1", [
      { filename: "notes.txt", data: "hello" },
    ]);

    expect(seenUrl).toBe("https://example.atlassian.net/rest/api/3/issue/PROJ-1/attachments");
    expect(seenInit.method).toBe("POST");

    const headers = seenInit.headers as Record<string, string>;
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    // fetch must set the multipart Content-Type itself so the boundary matches the body.
    expect(headers["Content-Type"]).toBeUndefined();

    const form = seenInit.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("notes.txt");
    // The runtime may append a charset to text types; the base type is what Jira records.
    expect(file.type).toStartWith("text/plain");
    expect(await file.text()).toBe("hello");

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.id).toBe("10001");
  });

  it("sends every file under the file field", async () => {
    let form: FormData | undefined;
    stubFetch((_url, init) => {
      form = init.body as FormData;
      return jsonResponse([{ id: "1" }, { id: "2" }]);
    });

    await new AtlassianClient(config).addJiraAttachments("PROJ-1", [
      { filename: "a.txt", data: "a" },
      { filename: "b.png", data: new Uint8Array([1, 2, 3]) },
    ]);

    const files = form?.getAll("file") as File[];
    expect(files.map((f) => f.name)).toEqual(["a.txt", "b.png"]);
    expect(files[1]?.type).toBe("image/png");
  });

  it("honors an explicit content type", async () => {
    let form: FormData | undefined;
    stubFetch((_url, init) => {
      form = init.body as FormData;
      return jsonResponse([{ id: "1" }]);
    });

    await new AtlassianClient(config).addJiraAttachments("PROJ-1", [
      { filename: "report.bin", data: "x", contentType: "application/pdf" },
    ]);

    expect((form?.get("file") as File).type).toBe("application/pdf");
  });

  it("encodes issue keys into the path", async () => {
    let seenUrl = "";
    stubFetch((url) => {
      seenUrl = url;
      return jsonResponse([{ id: "1" }]);
    });

    await new AtlassianClient(config).addJiraAttachments("PROJ 1/2", [{ filename: "a.txt", data: "a" }]);

    expect(seenUrl).toContain("/issue/PROJ%201%2F2/attachments");
  });

  it("rejects an empty file list without calling the API", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return jsonResponse([]);
    });

    await expect(new AtlassianClient(config).addJiraAttachments("PROJ-1", [])).rejects.toThrow(
      /At least one file/
    );
    expect(called).toBe(false);
  });

  it("maps API errors to typed errors", async () => {
    stubFetch(() => jsonResponse({ errorMessages: ["Issue does not exist"] }, 404));

    await expect(
      new AtlassianClient(config).addJiraAttachments("PROJ-404", [{ filename: "a.txt", data: "a" }])
    ).rejects.toThrow(/Issue does not exist/);
  });
});

describe("guessContentType", () => {
  it("maps known extensions case-insensitively", () => {
    expect(guessContentType("shot.PNG")).toBe("image/png");
    expect(guessContentType("notes.md")).toBe("text/markdown");
  });

  it("falls back to octet-stream", () => {
    expect(guessContentType("archive.unknownext")).toBe("application/octet-stream");
    expect(guessContentType("noextension")).toBe("application/octet-stream");
  });
});
