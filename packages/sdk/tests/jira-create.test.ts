import { afterEach, describe, expect, it } from "bun:test";
import { AtlassianClient } from "../src/client.js";
import { AtlassianFieldError } from "../src/errors.js";

const originalFetch = globalThis.fetch;

function createClient(): AtlassianClient {
  return new AtlassianClient({
    siteUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "test-token",
  });
}

/** Keyed the way Atlassian's own v3 spec keys it: `issueTypes`, not `values`. */
const issueTypes = {
  maxResults: 50,
  startAt: 0,
  total: 3,
  issueTypes: [
    { id: "10001", name: "Bug" },
    { id: "10002", name: "Jira Task" },
    { id: "10003", name: "Sub-task", subtask: true },
  ],
};

/** A trimmed `createmeta/.../issuetypes/<id>` response for a Bug, keyed `fields` as the spec does. */
const bugFields = {
  maxResults: 50,
  startAt: 0,
  total: 9,
  fields: [
    { fieldId: "project", name: "Project", required: true, hasDefaultValue: false, schema: { type: "project", system: "project" } },
    { fieldId: "issuetype", name: "Issue Type", required: true, schema: { type: "issuetype", system: "issuetype" } },
    { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
    { fieldId: "description", name: "Description", required: false, schema: { type: "string", system: "description" } },
    { fieldId: "assignee", name: "Assignee", required: false, schema: { type: "user", system: "assignee" } },
    { fieldId: "labels", name: "Labels", required: false, schema: { type: "array", items: "string", system: "labels" } },
    {
      fieldId: "priority",
      name: "Priority",
      required: false,
      schema: { type: "priority", system: "priority" },
      allowedValues: [{ name: "High" }, { name: "Low" }],
    },
    {
      fieldId: "customfield_13841",
      name: "Task Category",
      required: false,
      schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" },
      allowedValues: [{ value: "Support" }, { value: "Feature" }],
    },
    {
      fieldId: "customfield_10500",
      name: "Sprint",
      required: false,
      schema: { type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" },
    },
  ],
};

/** A Jira Task create screen: no Story Points field, which is the usual field_not_settable case. */
const jiraTaskFields = {
  maxResults: 50,
  startAt: 0,
  total: 3,
  fields: [
    { fieldId: "project", name: "Project", required: true, schema: { type: "project", system: "project" } },
    { fieldId: "issuetype", name: "Issue Type", required: true, schema: { type: "issuetype", system: "issuetype" } },
    { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
  ],
};

const subtaskFields = {
  maxResults: 50,
  startAt: 0,
  total: 4,
  fields: [
    { fieldId: "project", name: "Project", required: true, schema: { type: "project", system: "project" } },
    { fieldId: "issuetype", name: "Issue Type", required: true, schema: { type: "issuetype", system: "issuetype" } },
    { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
    { fieldId: "parent", name: "Parent", required: true, hasDefaultValue: false, schema: { type: "issuelink", system: "parent" } },
  ],
};

const createdIssue = { id: "1234567", key: "DMP-2470", self: "https://example.atlassian.net/rest/api/3/issue/1234567" };

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** Routes by URL rather than call order, since metadata lookups are cached and may not repeat. */
function mockFetch(handler: (url: string, method: string) => { body: unknown; status?: number }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    calls.push({ url, method, body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody });
    const response = handler(url, method);
    return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function routeBug(url: string, method: string): { body: unknown; status?: number } {
  if (url.includes("/issuetypes/10001")) return { body: bugFields };
  if (url.includes("/issuetypes/10002")) return { body: jiraTaskFields };
  if (url.includes("/issuetypes/10003")) return { body: subtaskFields };
  if (url.includes("/createmeta/")) return { body: issueTypes };
  if (url.includes("/user/search")) return { body: [{ accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Dana Scully", emailAddress: "dana@example.com", active: true }] };
  if (url.endsWith("/rest/api/3/issue") && method === "POST") return { body: createdIssue };
  throw new Error(`unexpected request: ${method} ${url}`);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createJiraIssue", () => {
  it("resolves the issue type and every field against the create screen, then posts the issue", async () => {
    const calls = mockFetch(routeBug);

    const result = await createClient().createJiraIssue({
      project: "DMP",
      issueType: "bug",
      summary: "Login times out",
      fields: { "Task Category": "support", Priority: "High", labels: "audit,login" },
    });

    expect(result).toMatchObject({
      status: "created",
      key: "DMP-2470",
      id: "1234567",
      url: "https://example.atlassian.net/browse/DMP-2470",
      project: "DMP",
      issueType: { id: "10001", name: "Bug" },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.atlassian.net/rest/api/3/issue/createmeta/DMP/issuetypes?startAt=0&maxResults=50",
      "https://example.atlassian.net/rest/api/3/issue/createmeta/DMP/issuetypes/10001?startAt=0&maxResults=50",
      "https://example.atlassian.net/rest/api/3/issue",
    ]);
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.body).toEqual({
      fields: {
        summary: "Login times out",
        customfield_13841: { value: "Support" },
        priority: { name: "High" },
        labels: ["audit", "login"],
        project: { key: "DMP" },
        issuetype: { id: "10001" },
      },
    });
    // The reported payload is the payload that was sent, not the fields minus the two it adds.
    expect(result.fields).toEqual((calls[2]?.body as { fields: Record<string, unknown> }).fields);
  });

  it("converts a markdown description to ADF, since Jira v3 rejects a plain string", async () => {
    const calls = mockFetch(routeBug);

    await createClient().createJiraIssue({
      project: "DMP",
      issueType: "Bug",
      summary: "Login times out",
      description: "## Steps\n\n- open login\n- wait",
    });

    const fields = (calls[2]?.body as { fields: { description: { type: string; content: Array<{ type: string }> } } }).fields;
    expect(fields.description.type).toBe("doc");
    expect(fields.description.content.map((node) => node.type)).toEqual(["heading", "bulletList"]);
  });

  it("sends the sprint field as a single id rather than the array its schema publishes", async () => {
    const calls = mockFetch(routeBug);

    const result = await createClient().createJiraIssue({
      project: "DMP",
      issueType: "Bug",
      summary: "Login times out",
      fields: { Sprint: "5238" },
    });

    expect((calls[2]?.body as { fields: Record<string, unknown> }).fields.customfield_10500).toBe(5238);
    expect(result.resolved.find((field) => field.fieldId === "customfield_10500")?.value).toBe(5238);
  });

  it("resolves an assignee email to an account id", async () => {
    const calls = mockFetch(routeBug);

    await createClient().createJiraIssue({
      project: "DMP",
      issueType: "Bug",
      summary: "Login times out",
      fields: { assignee: "dana@example.com" },
    });

    expect(calls[2]?.url).toContain("/user/search");
    expect((calls[3]?.body as { fields: Record<string, unknown> }).fields.assignee).toEqual({ accountId: "5b10ac8d82e05b22cc7d4ef5" });
  });

  it("sends a parent as an issue key reference", async () => {
    const calls = mockFetch(routeBug);

    await createClient().createJiraIssue({ project: "DMP", issueType: "Sub-task", summary: "Write the migration", parent: "DMP-123" });

    expect((calls[2]?.body as { fields: Record<string, unknown> }).fields.parent).toEqual({ key: "DMP-123" });
  });

  it("resolves the payload without creating anything on a dry run", async () => {
    const calls = mockFetch(routeBug);

    const result = await createClient().createJiraIssue(
      { project: "DMP", issueType: "Bug", summary: "Login times out", fields: { "Task Category": "Support" } },
      { dryRun: true }
    );

    expect(result).toMatchObject({ status: "dry_run" });
    // A dry run has to print exactly what the create would send, project and issue type included.
    expect(result.fields).toEqual({
      summary: "Login times out",
      customfield_13841: { value: "Support" },
      project: { key: "DMP" },
      issuetype: { id: "10001" },
    });
    expect(result.key).toBeUndefined();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects an unknown issue type with the project's real types", async () => {
    mockFetch(routeBug);

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "NotAThing", summary: "x" });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlassianFieldError);
      expect((err as AtlassianFieldError).code).toBe("invalid_issue_type");
      const details = (err as AtlassianFieldError).details as { issueTypes: Array<{ name: string }> };
      expect(details.issueTypes.map((type) => type.name)).toEqual(["Bug", "Jira Task", "Sub-task"]);
    }
  });

  it("reports a required field the create leaves out, before writing anything", async () => {
    const calls = mockFetch(routeBug);

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Sub-task", summary: "Write the migration" });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("missing_required_field");
      const details = (err as AtlassianFieldError).details as { requiredFields: Array<{ id: string }> };
      expect(details.requiredFields.map((field) => field.id)).toEqual(["parent"]);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    }
  });

  it("reports the settable fields when a field is not on that issue type's create screen", async () => {
    mockFetch(routeBug);

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Jira Task", summary: "x", fields: { "Story Points": "3" } });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("field_not_settable");
      expect((err as Error).message).toContain("Jira Task in DMP");
      const details = (err as AtlassianFieldError).details as { settableFields: Array<{ id: string }> };
      expect(details.settableFields.map((field) => field.id)).toContain("summary");
    }
  });

  it("re-codes Jira's 400 on a bad parent as invalid_parent", async () => {
    mockFetch((url, method) => {
      if (url.endsWith("/rest/api/3/issue") && method === "POST") {
        return { body: { errorMessages: [], errors: { parent: "Issue DMP-99999 does not exist or you do not have permission to see it." } }, status: 400 };
      }
      return routeBug(url, method);
    });

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Sub-task", summary: "x", parent: "DMP-99999" });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("invalid_parent");
      expect((err as Error).message).toContain("does not exist");
    }
  });

  it("requires a project, from the argument or the configured default", async () => {
    mockFetch(routeBug);

    await expect(createClient().createJiraIssue({ issueType: "Bug", summary: "x" })).rejects.toThrow(/ATLASSIAN_JIRA_PROJECT/);
  });

  it("uses the configured default project when none is passed", async () => {
    const calls = mockFetch(routeBug);
    const client = new AtlassianClient({
      siteUrl: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "test-token",
      jiraProject: "DMP",
    });

    const result = await client.createJiraIssue({ issueType: "Bug", summary: "Login times out" });

    expect(result.project).toBe("DMP");
    expect(calls[0]?.url).toContain("/createmeta/DMP/issuetypes");
  });
});

describe("createJiraIssues", () => {
  it("creates the good records and reports the bad one per record", async () => {
    const calls = mockFetch(routeBug);

    const batch = await createClient().createJiraIssues([
      { project: "DMP", issueType: "Bug", summary: "Login times out" },
      { project: "DMP", issueType: "NotAThing", summary: "Broken record" },
      { project: "DMP", issueType: "Bug", summary: "Logout times out" },
    ]);

    expect(batch).toMatchObject({ created: 2, failed: 1 });
    expect(batch.results[0]).toMatchObject({ index: 0, status: "created", key: "DMP-2470" });
    expect(batch.results[1]).toMatchObject({ index: 1, status: "error", code: "invalid_issue_type", summary: "Broken record" });
    expect(batch.results[2]).toMatchObject({ index: 2, status: "created" });
    // Metadata is cached per client, so the batch costs two lookups plus one POST per issue.
    expect(calls.filter((call) => call.url.includes("/createmeta/"))).toHaveLength(2);
  });
});

describe("createmeta paging and response shapes", () => {
  it("reads a page keyed `values` as well as the spec's `issueTypes` and `fields`", async () => {
    mockFetch((url) => {
      if (url.includes("/issuetypes/10001")) return { body: { ...bugFields, fields: undefined, values: bugFields.fields } };
      if (url.includes("/createmeta/")) return { body: { ...issueTypes, issueTypes: undefined, values: issueTypes.issueTypes } };
      return { body: createdIssue };
    });

    const result = await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "Login times out" });

    expect(result.status).toBe("created");
  });

  it("walks every page of issue types and fields", async () => {
    const typePage = (startAt: number) => ({
      maxResults: 1,
      startAt,
      total: 2,
      issueTypes: [startAt === 0 ? { id: "10001", name: "Other" } : { id: "10009", name: "Bug" }],
    });
    const fieldPage = (startAt: number) => ({
      maxResults: 1,
      startAt,
      total: 2,
      fields: [
        startAt === 0
          ? { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } }
          : { fieldId: "customfield_13841", name: "Task Category", schema: { type: "option" }, allowedValues: [{ value: "Support" }] },
      ],
    });
    const calls = mockFetch((url, method) => {
      const startAt = Number(new URL(url).searchParams.get("startAt") ?? 0);
      if (url.includes("/issuetypes/10009")) return { body: fieldPage(startAt) };
      if (url.includes("/createmeta/")) return { body: typePage(startAt) };
      if (method === "POST") return { body: createdIssue };
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await createClient().createJiraIssue({
      project: "DMP",
      issueType: "Bug",
      summary: "Login times out",
      fields: { "Task Category": "Support" },
    });

    expect(result.issueType).toMatchObject({ id: "10009", name: "Bug" });
    expect(result.fields.customfield_13841).toEqual({ value: "Support" });
    expect(calls.filter((call) => call.url.includes("/createmeta/"))).toHaveLength(4);
  });

  it("stops on a short page even when the response reports no total", async () => {
    const calls = mockFetch((url, method) => {
      if (url.includes("/issuetypes/10001")) return { body: { fields: bugFields.fields } };
      if (url.includes("/createmeta/")) return { body: { issueTypes: issueTypes.issueTypes } };
      if (method === "POST") return { body: createdIssue };
      throw new Error(`unexpected request: ${url}`);
    });

    await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "Login times out" });

    expect(calls.filter((call) => call.url.includes("/createmeta/"))).toHaveLength(2);
  });
});

describe("create payload guards", () => {
  it("refuses a project or issuetype passed as a field instead of overriding it silently", async () => {
    mockFetch(routeBug);

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "x", fields: { project: "OTHER" } });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("field_not_settable");
      expect((err as Error).message).toContain("project is set from");
    }
  });

  it("refuses a summary given both as the shorthand and as a field", async () => {
    mockFetch(routeBug);

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "A", fields: { summary: "B" } });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("field_duplicated");
    }
  });
});

describe("Jira 400 translation", () => {
  function mockCreate400(body: unknown) {
    return mockFetch((url, method) => (url.endsWith("/rest/api/3/issue") && method === "POST" ? { body, status: 400 } : routeBug(url, method)));
  }

  it("re-codes a required-field rejection Jira words as 'must specify'", async () => {
    mockCreate400({ errorMessages: [], errors: { summary: "You must specify a summary of the issue." } });

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "x" });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("missing_required_field");
      expect((err as AtlassianFieldError).details).toMatchObject({ requiredFields: [{ id: "summary" }] });
    }
  });

  it("re-codes any other field rejection as invalid_field_value, naming the field", async () => {
    mockCreate400({ errorMessages: [], errors: { customfield_13841: "Option id 'nope' is not valid" } });

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "x" });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("invalid_field_value");
      expect((err as Error).message).toContain("customfield_13841");
    }
  });

  it("leaves an error that carries no field map alone", async () => {
    mockFetch((url, method) =>
      url.endsWith("/rest/api/3/issue") && method === "POST" ? { body: { message: "Service temporarily unavailable" }, status: 503 } : routeBug(url, method)
    );

    await expect(createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "x" })).rejects.toThrow(/Service temporarily unavailable/);
  });
});

describe("resolveJiraAccountId", () => {
  it("passes an account id through without searching", async () => {
    const calls = mockFetch(routeBug);

    await createClient().createJiraIssue({
      project: "DMP",
      issueType: "Bug",
      summary: "x",
      fields: { assignee: "5b10ac8d82e05b22cc7d4ef5" },
    });

    expect(calls.some((call) => call.url.includes("/user/search"))).toBe(false);
  });

  it("reports a display name that matches no user", async () => {
    mockFetch((url, method) => (url.includes("/user/search") ? { body: [] } : routeBug(url, method)));

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "x", fields: { assignee: "Nobody Here" } });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("user_not_found");
    }
  });

  it("refuses an ambiguous name, listing the candidates", async () => {
    mockFetch((url, method) =>
      url.includes("/user/search")
        ? {
            body: [
              { accountId: "111111111111111111111111", displayName: "Dana Scully", active: true },
              { accountId: "222222222222222222222222", displayName: "Dana Scully", active: true },
            ],
          }
        : routeBug(url, method)
    );

    try {
      await createClient().createJiraIssue({ project: "DMP", issueType: "Bug", summary: "x", fields: { assignee: "Dana Scully" } });
      throw new Error("expected createJiraIssue to throw");
    } catch (err) {
      expect((err as AtlassianFieldError).code).toBe("user_ambiguous");
      const details = (err as AtlassianFieldError).details as { candidates: Array<{ accountId: string }> };
      expect(details.candidates).toHaveLength(2);
    }
  });
});
