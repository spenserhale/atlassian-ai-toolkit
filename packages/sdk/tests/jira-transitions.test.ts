import { afterEach, describe, expect, it } from "bun:test";
import { AtlassianClient } from "../src/client.js";
import { AtlassianFieldError } from "../src/errors.js";
import { resolveJiraTransition, summarizeJiraTransition } from "../src/jira-transitions.js";
import type { JiraTransition } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createClient(): AtlassianClient {
  return new AtlassianClient({ siteUrl: "https://example.atlassian.net", email: "user@example.com", apiToken: "test-token" });
}

/** A trimmed `/transitions?expand=transitions.fields` response for an issue in To Do. */
const transitionsFixture = {
  transitions: [
    { id: "11", name: "Start Progress", to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } }, hasScreen: false, fields: {} },
    {
      id: "31",
      name: "Close",
      to: { id: "10002", name: "Done", statusCategory: { key: "done", name: "Done" } },
      hasScreen: true,
      fields: {
        resolution: {
          required: true,
          name: "Resolution",
          schema: { type: "resolution", system: "resolution" },
          allowedValues: [{ id: "1", name: "Done" }, { id: "2", name: "Won't Do" }],
        },
        customfield_13841: {
          required: false,
          name: "Task Category",
          schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
          allowedValues: [{ value: "Support" }, { value: "Feature" }],
        },
        assignee: { required: false, name: "Assignee", schema: { type: "user", system: "assignee" } },
      },
    },
  ],
};

const transitions = transitionsFixture.transitions as JiraTransition[];

type Route = { body?: unknown; status?: number };

function mockFetch(route: (url: string, method: string, body: unknown) => Route): Array<{ url: string; method: string; body: unknown }> {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const response = route(url, method, body);
    if (response.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function routeTransitions(url: string, method: string): Route {
  if (url.includes("/transitions") && method === "GET") return { body: transitionsFixture };
  if (url.includes("/transitions") && method === "POST") return { status: 204 };
  if (url.includes("/user/search")) return { body: [{ accountId: "5b10a2844c20165700ede21g", displayName: "Ada Lovelace", emailAddress: "ada@example.com" }] };
  return { body: { errorMessages: [`unexpected ${method} ${url}`] }, status: 500 };
}

describe("resolveJiraTransition", () => {
  it("matches a transition id exactly", () => {
    expect(resolveJiraTransition(transitions, "31", "DMP-1").name).toBe("Close");
  });

  it("matches a transition name case-insensitively", () => {
    expect(resolveJiraTransition(transitions, "start progress", "DMP-1").id).toBe("11");
  });

  it("falls back to the target status name", () => {
    expect(resolveJiraTransition(transitions, "done", "DMP-1").id).toBe("31");
  });

  it("prefers a transition name over another transition's target status", () => {
    const list = [
      { id: "1", name: "Done", to: { name: "Closed" } },
      { id: "2", name: "Finish", to: { name: "Done" } },
    ] as JiraTransition[];
    expect(resolveJiraTransition(list, "Done", "DMP-1").id).toBe("1");
  });

  it("fails on a miss and lists the available transitions", () => {
    try {
      resolveJiraTransition(transitions, "Blocked", "DMP-1");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlassianFieldError);
      expect((err as AtlassianFieldError).code).toBe("transition_not_available");
      expect((err as Error).message).toContain("11 Start Progress -> In Progress");
      expect((err as Error).message).toContain("31 Close -> Done");
      expect((err as AtlassianFieldError).details).toEqual({
        transition: "Blocked",
        available: [
          { id: "11", name: "Start Progress", to: "In Progress" },
          { id: "31", name: "Close", to: "Done" },
        ],
      });
    }
  });

  it("fails when two transitions lead to the same status", () => {
    const list = [
      { id: "1", name: "Resolve", to: { name: "Done" } },
      { id: "2", name: "Won't Do", to: { name: "Done" } },
    ] as JiraTransition[];
    try {
      resolveJiraTransition(list, "Done", "DMP-1");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("transition_ambiguous");
      expect((err as AtlassianFieldError).details).toMatchObject({ candidates: [{ id: "1" }, { id: "2" }] });
    }
  });
});

describe("summarizeJiraTransition", () => {
  it("reports the target status, screen fields, and required fields", () => {
    const summary = summarizeJiraTransition(transitions[1] as JiraTransition);
    expect(summary).toMatchObject({ id: "31", name: "Close", to: { id: "10002", name: "Done", category: "Done" }, hasScreen: true });
    expect(summary.fields.map((field) => field.id)).toEqual(["assignee", "customfield_13841", "resolution"]);
    expect(summary.requiredFields).toEqual([{ id: "resolution", name: "Resolution", type: "resolution" }]);
  });
});

describe("AtlassianClient transitions", () => {
  it("lists transitions with screen fields expanded", async () => {
    const calls = mockFetch(routeTransitions);

    const list = await createClient().listJiraIssueTransitions("DMP-1");

    expect(calls[0]?.url).toBe("https://example.atlassian.net/rest/api/3/issue/DMP-1/transitions?expand=transitions.fields");
    expect(list.map((transition) => [transition.id, transition.name, transition.to.name])).toEqual([
      ["11", "Start Progress", "In Progress"],
      ["31", "Close", "Done"],
    ]);
  });

  it("transitions by target status with coerced screen fields", async () => {
    const calls = mockFetch(routeTransitions);

    const result = await createClient().transitionJiraIssue("DMP-1", { to: "Done", fields: { resolution: "done", "Task Category": "support" } });

    expect(result.status).toBe("transitioned");
    expect(result.transition).toMatchObject({ id: "31", to: { name: "Done" } });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("https://example.atlassian.net/rest/api/3/issue/DMP-1/transitions");
    expect(post?.body).toEqual({
      transition: { id: "31" },
      fields: { resolution: { name: "Done" }, customfield_13841: { value: "Support" } },
    });
  });

  it("sends no fields key for a bare transition", async () => {
    const calls = mockFetch(routeTransitions);

    await createClient().transitionJiraIssue("DMP-1", { to: "Start Progress" });

    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ transition: { id: "11" } });
  });

  it("resolves a user field on the screen to an account id", async () => {
    const calls = mockFetch(routeTransitions);

    await createClient().transitionJiraIssue("DMP-1", { to: "Close", fields: { Assignee: "ada@example.com" } });

    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ fields: { assignee: { accountId: "5b10a2844c20165700ede21g" } } });
  });

  it("dry run resolves everything and sends no POST", async () => {
    const calls = mockFetch(routeTransitions);

    const result = await createClient().transitionJiraIssue("DMP-1", { to: "close", fields: { resolution: "Done" } }, { dryRun: true });

    expect(result.status).toBe("dry_run");
    expect(result.fields).toEqual({ resolution: { name: "Done" } });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects a field that is not on the transition screen with the screen's fields", async () => {
    const calls = mockFetch(routeTransitions);

    try {
      await createClient().transitionJiraIssue("DMP-1", { to: "Done", fields: { "Story Points": 3 } });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("field_not_settable");
      expect((err as Error).message).toContain('the "Close" transition screen');
      expect((err as AtlassianFieldError).details).toMatchObject({ settableFields: [{ id: "assignee" }, { id: "customfield_13841" }, { id: "resolution" }] });
    }
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects fields on a transition without a screen", async () => {
    mockFetch(routeTransitions);

    await expect(createClient().transitionJiraIssue("DMP-1", { to: "In Progress", fields: { resolution: "Done" } })).rejects.toMatchObject({
      code: "field_not_settable",
    });
  });

  it("fails before any POST when --to matches nothing", async () => {
    const calls = mockFetch(routeTransitions);

    await expect(createClient().transitionJiraIssue("DMP-1", { to: "Blocked" })).rejects.toMatchObject({ code: "transition_not_available" });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("re-codes a Jira field rejection on the move", async () => {
    mockFetch((url, method) =>
      url.includes("/transitions") && method === "POST"
        ? { body: { errorMessages: [], errors: { resolution: "Resolution is required." } }, status: 400 }
        : routeTransitions(url, method)
    );

    try {
      await createClient().transitionJiraIssue("DMP-1", { to: "Done" });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("missing_required_field");
      expect((err as Error).message).toBe("Jira rejected the transition: Resolution is required.");
    }
  });
});
