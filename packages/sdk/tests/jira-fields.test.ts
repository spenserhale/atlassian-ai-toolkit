import { describe, expect, it } from "bun:test";
import { AtlassianFieldError } from "../src/errors.js";
import { listSettableJiraFields, planJiraIssueFieldEdits, resolveJiraField } from "../src/jira-fields.js";
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
