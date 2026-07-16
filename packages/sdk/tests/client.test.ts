import { afterEach, describe, expect, it } from "bun:test";
import { AtlassianClient } from "../src/client.js";

const originalFetch = globalThis.fetch;

function createClient(): AtlassianClient {
  return new AtlassianClient({
    siteUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "test-token",
  });
}

function mockJsonFetch(body: unknown, status = 200): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AtlassianClient", () => {
  it("requires Atlassian Cloud auth config", () => {
    expect(
      () => new AtlassianClient({ siteUrl: "", email: "", apiToken: "" })
    ).toThrow();
  });

  it("accepts a valid config", () => {
    const client = createClient();

    expect(client).toBeDefined();
  });

  it("gets a Jira sprint through the Agile API", async () => {
    const calls = mockJsonFetch({ id: 42, self: "https://example.atlassian.net/rest/agile/1.0/sprint/42", state: "active", name: "Sprint 42" });

    const sprint = await createClient().getJiraSprint(42);

    expect(sprint).toMatchObject({ id: 42, state: "active", name: "Sprint 42" });
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint/42");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("lists Jira sprints for a board with state filtering", async () => {
    const calls = mockJsonFetch({ values: [{ id: 7, state: "future", name: "Next Sprint" }] });

    const result = await createClient().listJiraSprints(123, { state: "future" });

    expect(result.values).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/board/123/sprint?state=future");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("creates a future Jira sprint", async () => {
    const calls = mockJsonFetch({ id: 8, state: "future", name: "Next Sprint", originBoardId: 123 });

    const sprint = await createClient().createJiraSprint({
      originBoardId: 123,
      name: "Next Sprint",
      goal: "Ship sprint lifecycle",
      startDate: "2026-07-06T15:00:00.000Z",
      endDate: "2026-07-17T22:00:00.000Z",
    });

    expect(sprint.id).toBe(8);
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      originBoardId: 123,
      name: "Next Sprint",
      goal: "Ship sprint lifecycle",
      startDate: "2026-07-06T15:00:00.000Z",
      endDate: "2026-07-17T22:00:00.000Z",
    });
  });

  it("updates a Jira sprint", async () => {
    const calls = mockJsonFetch({ id: 42, state: "closed", name: "Sprint 42" });

    await createClient().updateJiraSprint(42, {
      name: "Sprint 42",
      state: "closed",
    });

    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint/42");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Sprint 42",
      state: "closed",
    });
  });

  it("moves Jira sprint issues to another sprint", async () => {
    const calls = mockJsonFetch(undefined, 204);

    await createClient().moveJiraSprintIssues({ issueKeys: ["PROJ-1", "PROJ-2"], targetSprintId: 99 });

    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint/99/issue");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ issues: ["PROJ-1", "PROJ-2"] });
  });

  it("moves Jira sprint issues to the backlog", async () => {
    const calls = mockJsonFetch(undefined, 204);

    await createClient().moveJiraSprintIssues({ issueKeys: ["PROJ-3"], target: "backlog" });

    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/backlog/issue");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ issues: ["PROJ-3"] });
  });

  it("uploads a Confluence attachment as multipart create-or-update by default", async () => {
    const calls = mockJsonFetch({ results: [{ id: "att-1", type: "attachment", status: "current", title: "report.txt" }] });

    const result = await createClient().uploadConfluenceAttachment("12345", {
      file: new Blob(["hello world"], { type: "text/plain" }),
      filename: "report.txt",
      comment: "Quarterly report",
    });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    const body = calls[0]?.init?.body as FormData;
    const file = body.get("file") as File;

    expect(result.results[0]?.id).toBe("att-1");
    expect(calls[0]?.url).toBe("https://example.atlassian.net/wiki/rest/api/content/12345/child/attachment");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(headers["X-Atlassian-Token"]).toBe("nocheck");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(body).toBeInstanceOf(FormData);
    expect(file.name).toBe("report.txt");
    expect(file.type.startsWith("text/plain")).toBe(true);
    expect(await file.text()).toBe("hello world");
    expect(body.get("minorEdit")).toBe("true");
    expect(body.get("comment")).toBe("Quarterly report");
  });

  it("uploads a Confluence attachment with create-only POST and watcher notifications", async () => {
    const calls = mockJsonFetch({ results: [{ id: "att-2", type: "attachment", status: "current", title: "diagram.png" }] });

    await createClient().uploadConfluenceAttachment("12345", {
      file: new Blob(["image-bytes"], { type: "image/png" }),
      filename: "diagram.png",
      createOnly: true,
      minorEdit: false,
    });

    const body = calls[0]?.init?.body as FormData;

    expect(calls[0]?.url).toBe("https://example.atlassian.net/wiki/rest/api/content/12345/child/attachment");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(body.get("minorEdit")).toBe("false");
    expect(body.get("comment")).toBeNull();
  });
});
