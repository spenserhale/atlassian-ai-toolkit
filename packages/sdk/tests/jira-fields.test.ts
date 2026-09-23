import { describe, expect, it } from "bun:test";
import { AtlassianFieldError } from "../src/errors.js";
import { listMissingRequiredJiraFields, listRequiredJiraFields, listSettableJiraFields, planJiraIssueFieldEdits, resolveJiraField } from "../src/jira-fields.js";
import { JiraIssueEditMetaSchema } from "../src/types.js";

const meta = JiraIssueEditMetaSchema.parse({
  fields: {
    customfield_13841: {
      name: "Task Category",
      schema: { type: "option" },
      allowedValues: [{ value: "Support" }, { value: "Feature" }],
    },
    customfield_13834: {
      name: "Request Category",
      schema: { type: "array", items: "option" },
      allowedValues: [{ value: "Bug Fix" }, { value: "Enhancement" }],
    },
    customfield_10105: { name: "Story Points", schema: { type: "number" } },
    labels: { name: "Labels", schema: { type: "array", items: "string" } },
    assignee: { name: "Assignee", schema: { type: "user" } },
    priority: { name: "Priority", schema: { type: "priority" }, allowedValues: [{ name: "High" }, { name: "Low" }] },
    duedate: { name: "Due date", schema: { type: "date" } },
    description: { name: "Description", schema: { type: "string", system: "description" } },
    parent: { name: "Parent", required: true, schema: { type: "issuelink", system: "parent" } },
    customfield_10500: { name: "Sprint", schema: { type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
    summary: { name: "Summary", required: true, schema: { type: "string", system: "summary" } },
    reporter: { name: "Reporter", required: true, hasDefaultValue: true, schema: { type: "user", system: "reporter" } },
  },
});

describe("planJiraIssueFieldEdits", () => {
  it("coerces each value to the shape its field schema requires", () => {
    const plan = planJiraIssueFieldEdits(meta, {
      customfield_13841: "Support",
      customfield_13834: "Bug Fix,Enhancement",
      customfield_10105: "2",
      labels: "audit,sprint-close",
      assignee: "5b10ac8d82e05b22cc7d4ef5",
      priority: "High",
      duedate: "2026-09-30",
    });

    expect(plan.fields).toEqual({
      customfield_13841: { value: "Support" },
      customfield_13834: [{ value: "Bug Fix" }, { value: "Enhancement" }],
      customfield_10105: 2,
      labels: ["audit", "sprint-close"],
      assignee: { accountId: "5b10ac8d82e05b22cc7d4ef5" },
      priority: { name: "High" },
      duedate: "2026-09-30",
    });
  });

  it("resolves display names as well as field ids", () => {
    const plan = planJiraIssueFieldEdits(meta, { "Task Category": "support" });

    expect(plan.fields).toEqual({ customfield_13841: { value: "Support" } });
    expect(plan.resolved[0]).toMatchObject({ input: "Task Category", fieldId: "customfield_13841", type: "option" });
  });

  it("passes an already-shaped object or array through untouched", () => {
    const plan = planJiraIssueFieldEdits(meta, { customfield_13841: { id: "14501" }, labels: ["audit"] });

    expect(plan.fields).toEqual({ customfield_13841: { id: "14501" }, labels: ["audit"] });
  });

  it("takes a json: prefix as an escape hatch and null as a clear", () => {
    const plan = planJiraIssueFieldEdits(meta, { customfield_13841: 'json:{"id":"14501"}', labels: null });

    expect(plan.fields).toEqual({ customfield_13841: { id: "14501" }, labels: null });
  });

  it("rejects a value the field does not allow, listing what it does", () => {
    try {
      planJiraIssueFieldEdits(meta, { customfield_13841: "Chore" });
      throw new Error("expected planJiraIssueFieldEdits to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlassianFieldError);
      expect((err as AtlassianFieldError).code).toBe("field_value_not_allowed");
      expect((err as AtlassianFieldError).details).toMatchObject({ allowedValues: ["Support", "Feature"] });
    }
  });

  it("rejects a non-numeric value for a number field", () => {
    expect(() => planJiraIssueFieldEdits(meta, { customfield_10105: "two" })).toThrow(/expects a number/);
  });

  it("requires at least one field", () => {
    expect(() => planJiraIssueFieldEdits(meta, {})).toThrow(/at least one field/);
  });
});

describe("resolveJiraField", () => {
  it("reports the settable fields when a field cannot be set on the issue", () => {
    try {
      resolveJiraField(meta, "customfield_99999");
      throw new Error("expected resolveJiraField to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlassianFieldError);
      expect((err as AtlassianFieldError).code).toBe("field_not_settable");
      const details = (err as AtlassianFieldError).details as { settableFields: Array<{ id: string }> };
      expect(details.settableFields.map((field) => field.id)).toContain("customfield_10105");
    }
  });

  it("refuses an ambiguous display name instead of picking one", () => {
    const ambiguous = JiraIssueEditMetaSchema.parse({
      fields: {
        customfield_1: { name: "Category", schema: { type: "option" } },
        customfield_2: { name: "Category", schema: { type: "option" } },
      },
    });

    expect(() => resolveJiraField(ambiguous, "Category")).toThrow(/more than one field/);
  });
});

describe("listSettableJiraFields", () => {
  it("lists every field on the edit screen with its id, name, and type", () => {
    expect(listSettableJiraFields(meta)).toContainEqual({ id: "customfield_10105", name: "Story Points", type: "number" });
  });
});

describe("rich text, sprint, and parent fields", () => {
  it("converts a markdown description to ADF rather than sending a string Jira rejects", () => {
    const plan = planJiraIssueFieldEdits(meta, { description: "A **bold** line" });
    const description = plan.fields.description as { type: string; content: Array<{ type: string }> };

    expect(description.type).toBe("doc");
    expect(description.content[0]?.type).toBe("paragraph");
  });

  it("passes an ADF document a caller already built through untouched", () => {
    const doc = { type: "doc", version: 1, content: [] };
    const plan = planJiraIssueFieldEdits(meta, { description: doc });

    expect(plan.fields.description).toBe(doc);
  });

  it("treats a field whose schema type is doc as rich text", () => {
    const docMeta = JiraIssueEditMetaSchema.parse({ fields: { customfield_1: { name: "For QA", schema: { type: "doc" } } } });
    const plan = planJiraIssueFieldEdits(docMeta, { "For QA": "**steps** here" });

    expect((plan.fields.customfield_1 as { type: string }).type).toBe("doc");
  });

  it("sends the sprint field as one id, not the array its schema publishes", () => {
    expect(planJiraIssueFieldEdits(meta, { Sprint: "5238" }).fields).toEqual({ customfield_10500: 5238 });
  });

  it("names a parent by issue key", () => {
    expect(planJiraIssueFieldEdits(meta, { parent: "DMP-123" }).fields).toEqual({ parent: { key: "DMP-123" } });
  });
});

describe("listRequiredJiraFields", () => {
  it("skips project, issuetype, and anything Jira fills in itself", () => {
    expect(listRequiredJiraFields(meta).map((field) => field.id)).toEqual(["parent", "summary"]);
  });

  it("reports only the required fields the payload leaves out, with their options", () => {
    expect(listMissingRequiredJiraFields(meta, ["summary"])).toEqual([{ id: "parent", name: "Parent", type: "issuelink" }]);
    expect(listMissingRequiredJiraFields(meta, ["summary", "parent"])).toEqual([]);
  });
});
