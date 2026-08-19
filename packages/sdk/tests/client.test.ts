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

function mockSequentialJsonFetch(responses: Array<{ body: unknown; status?: number }>): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = responses[calls.length] ?? responses[responses.length - 1];
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
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
    const calls = mockJsonFetch({ values: [{ id: 7, state: "future", name: "Next Sprint" }], isLast: true });

    const result = await createClient().listJiraSprints(123, { state: "future" });

    expect(result.values).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/board/123/sprint?state=future&startAt=0&maxResults=50");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("auto-paginates sprints across multiple pages instead of truncating at the first page", async () => {
    const page1 = { values: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, state: "closed", name: `Sprint ${i + 1}` })) };
    const page2 = { values: Array.from({ length: 10 }, (_, i) => ({ id: i + 51, state: "closed", name: `Sprint ${i + 51}` })), isLast: true };
    const calls = mockSequentialJsonFetch([{ body: page1 }, { body: page2 }]);

    const result = await createClient().listJiraSprints(360, { state: "closed" });

    expect(result.values).toHaveLength(60);
    expect(result.values[59]?.id).toBe(60);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/board/360/sprint?state=closed&startAt=0&maxResults=50");
    expect(calls[1]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/board/360/sprint?state=closed&startAt=50&maxResults=50");
  });

  it("lists issues in a sprint in a single page", async () => {
    const calls = mockJsonFetch({
      startAt: 0,
      maxResults: 50,
      total: 2,
      isLast: true,
      issues: [
        { id: "10001", key: "PROJ-1", fields: { summary: "Fix login" } },
        { id: "10002", key: "PROJ-2", fields: { summary: "Ship rollover" } },
      ],
    });

    const result = await createClient().listJiraSprintIssues(42);

    expect(result.total).toBe(2);
    expect(result.issues.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint/42/issue?startAt=0&maxResults=50");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("lists every issue in a sprint across pages", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const pages = [
      {
        startAt: 0,
        maxResults: 50,
        total: 3,
        isLast: false,
        issues: [{ id: "1", key: "PROJ-1" }, { id: "2", key: "PROJ-2" }],
      },
      { startAt: 2, maxResults: 50, total: 3, isLast: true, issues: [{ id: "3", key: "PROJ-3" }] },
    ];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const page = pages[calls.length - 1] ?? pages[pages.length - 1];
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await createClient().listJiraSprintIssues(42);

    expect(result.total).toBe(3);
    expect(result.issues.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint/42/issue?startAt=0&maxResults=50");
    expect(calls[1]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint/42/issue?startAt=2&maxResults=50");
  });

  it("passes page size and field filters when listing sprint issues", async () => {
    const calls = mockJsonFetch({ startAt: 0, maxResults: 100, total: 0, isLast: true, issues: [] });

    const result = await createClient().listJiraSprintIssues(42, { maxResults: 100, fields: ["summary", "status"] });

    expect(result.issues).toHaveLength(0);
    expect(calls[0]?.url).toBe(
      "https://example.atlassian.net/rest/agile/1.0/sprint/42/issue?startAt=0&maxResults=100&fields=summary%2Cstatus"
    );
  });

  it("searches Jira issues with JQL in a single page", async () => {
    const calls = mockJsonFetch({
      isLast: true,
      issues: [{ id: "10001", key: "PROJ-1", fields: { summary: "Fix login" } }],
    });

    const result = await createClient().searchJiraIssues("project = PROJ");

    expect(result.issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/api/3/search/jql");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      jql: "project = PROJ",
      maxResults: 100,
      fields: ["*navigable"],
    });
  });

  it("searches Jira issues across pages with next page tokens", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const pages = [
      { issues: [{ id: "1", key: "PROJ-1" }, { id: "2", key: "PROJ-2" }], nextPageToken: "tok-1" },
      { issues: [{ id: "3", key: "PROJ-3" }], isLast: true },
    ];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const page = pages[calls.length - 1] ?? pages[pages.length - 1];
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await createClient().searchJiraIssues("project = PROJ");

    expect(result.issues.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ jql: "project = PROJ" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ nextPageToken: "tok-1" });
  });

  it("applies limit and field filters to JQL search", async () => {
    const calls = mockJsonFetch({
      isLast: true,
      issues: [{ id: "1", key: "PROJ-1" }, { id: "2", key: "PROJ-2" }, { id: "3", key: "PROJ-3" }],
    });

    const result = await createClient().searchJiraIssues("project = PROJ", { limit: 2, fields: ["summary", "status"] });

    expect(result.issues.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2"]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      maxResults: 100,
      fields: ["summary", "status"],
    });
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

    const result = await createClient().moveJiraSprintIssues({ issueKeys: ["PROJ-1", "PROJ-2"], targetSprintId: 99 });

    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/sprint/99/issue");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ issues: ["PROJ-1", "PROJ-2"] });
    expect(result).toEqual({ batches: 1, moved: 2, failed: [] });
  });

  it("moves Jira sprint issues to the backlog", async () => {
    const calls = mockJsonFetch(undefined, 204);

    const result = await createClient().moveJiraSprintIssues({ issueKeys: ["PROJ-3"], target: "backlog" });

    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/agile/1.0/backlog/issue");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ issues: ["PROJ-3"] });
    expect(result).toEqual({ batches: 1, moved: 1, failed: [] });
  });

  it("chunks moves over Jira's 50-issue limit into multiple batches", async () => {
    const issueKeys = Array.from({ length: 80 }, (_, i) => `PROJ-${i + 1}`);
    const calls = mockJsonFetch(undefined, 204);

    const result = await createClient().moveJiraSprintIssues({ issueKeys, targetSprintId: 5165 });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body)).issues).toHaveLength(50);
    expect(JSON.parse(String(calls[1]?.init?.body)).issues).toHaveLength(30);
    expect(result).toEqual({ batches: 2, moved: 80, failed: [] });
  });

  it("stops at the first failing batch and reports how much landed", async () => {
    const issueKeys = Array.from({ length: 60 }, (_, i) => `PROJ-${i + 1}`);
    const calls = mockSequentialJsonFetch([
      { body: undefined, status: 204 },
      { body: { errorMessages: ["Internal server error"] }, status: 500 },
    ]);

    const result = await createClient().moveJiraSprintIssues({ issueKeys, targetSprintId: 5165 });

    expect(calls).toHaveLength(2);
    expect(result.batches).toBe(2);
    expect(result.moved).toBe(50);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.batchIndex).toBe(1);
    expect(result.failed[0]?.issueKeys).toHaveLength(10);
    expect(result.failed[0]?.error).toContain("Internal server error");
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
