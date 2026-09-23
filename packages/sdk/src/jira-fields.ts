import { markdownToAdf } from "./adf.js";
import { AtlassianFieldError } from "./errors.js";
import type {
  JiraEditMetaField,
  JiraFieldEdits,
  JiraIssueEditMeta,
  JiraIssueEditPlan,
  JiraRequiredFieldGap,
  JiraResolvedFieldEdit,
  JiraSettableField,
} from "./types.js";

/** Prefix that hands a raw JSON value straight to Jira, for shapes the coercion table doesn't cover. */
const JSON_VALUE_PREFIX = "json:";

/** Field schema types whose edit payload is `{ name: ... }`. */
const NAME_KEYED_TYPES = new Set(["priority", "resolution", "issuetype", "status", "securitylevel", "version", "component", "group"]);

/** Field schema types whose value is sent as a bare string. */
const STRING_TYPES = new Set(["string", "date", "datetime", "any"]);

/** System fields Jira stores as an Atlassian Document, where a plain string is rejected. */
const ADF_SYSTEM_FIELDS = new Set(["description", "environment"]);

/** Custom field types Jira stores as an Atlassian Document. */
const ADF_CUSTOM_TYPES = new Set([
  "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
  "com.atlassian.jira.plugin.system.customfieldtypes:readonlyfield",
]);

/** The agile sprint field, whose write shape does not follow its own published schema. */
const SPRINT_CUSTOM_TYPE = "com.pyxis.greenhopper.jira:gh-sprint";

function isAdfField(field: JiraEditMetaField): boolean {
  const schema = field.schema;
  if (schema === undefined) return false;
  // Jira reports rich text as `doc` on newer screens and as a system or custom field type on older
  // ones, so all three are checked rather than the type alone.
  if (schema.type === "doc") return true;
  if (schema.system !== undefined && ADF_SYSTEM_FIELDS.has(schema.system)) return true;
  return schema.custom !== undefined && ADF_CUSTOM_TYPES.has(schema.custom);
}

/**
 * The sprint field publishes `array` of `json` but accepts only a single sprint id on write, so the
 * schema-driven table would send an array Jira rejects with "Number value expected".
 */
function isSprintField(field: JiraEditMetaField): boolean {
  return field.schema?.custom === SPRINT_CUSTOM_TYPE;
}

/** True when the field holds a user, whose value has to be an account id rather than a name. */
export function isJiraUserField(field: JiraEditMetaField): boolean {
  const schema = field.schema;
  if (schema?.type === "user") return true;
  return schema?.type === "array" && schema.items === "user";
}

/** Every field the issue's edit screen accepts, which is what `editmeta` reports. */
export function listSettableJiraFields(meta: JiraIssueEditMeta): JiraSettableField[] {
  return Object.entries(meta.fields)
    .map(([id, field]) => ({ id, name: field.name, type: field.schema?.type }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function allowedValueLabel(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.value === "string") return record.value;
  if (typeof record.name === "string") return record.name;
  return undefined;
}

function allowedValueLabels(field: JiraEditMetaField): string[] {
  return (field.allowedValues ?? []).map(allowedValueLabel).filter((label): label is string => label !== undefined);
}

/**
 * Matches an input against the field's published options case-insensitively and returns the
 * canonical casing, so "support" is accepted for "Support" instead of failing inside Jira.
 */
function matchAllowedValue(fieldId: string, field: JiraEditMetaField, raw: string): string {
  const labels = allowedValueLabels(field);
  if (labels.length === 0) return raw;
  const match = labels.find((label) => label.toLowerCase() === raw.trim().toLowerCase());
  if (match === undefined) {
    throw new AtlassianFieldError(
      `"${raw}" is not an allowed value for ${fieldId}${field.name ? ` (${field.name})` : ""}`,
      "field_value_not_allowed",
      { field: fieldId, name: field.name, allowedValues: labels }
    );
  }
  return match;
}

function coerceNumber(fieldId: string, field: JiraEditMetaField, raw: unknown): number {
  if (typeof raw === "number") return raw;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) {
    throw new AtlassianFieldError(
      `${fieldId}${field.name ? ` (${field.name})` : ""} expects a number (got: "${String(raw)}")`,
      "field_value_invalid",
      { field: fieldId, name: field.name, type: "number" }
    );
  }
  return parsed;
}

function coerceScalar(fieldId: string, field: JiraEditMetaField, type: string | undefined, raw: unknown): unknown {
  // An object or array is taken as the API shape the caller already knows it wants.
  if (typeof raw === "object" && raw !== null) return raw;
  if (type === "number") return coerceNumber(fieldId, field, raw);
  if (type === "option" || type === "option-with-child") return { value: matchAllowedValue(fieldId, field, String(raw)) };
  if (type === "user") return { accountId: String(raw) };
  if (type === "project") return { key: String(raw) };
  // `parent` and other issue links are named by issue key.
  if (type === "issuelink") return { key: String(raw) };
  if (type !== undefined && NAME_KEYED_TYPES.has(type)) return { name: matchAllowedValue(fieldId, field, String(raw)) };
  if (type === undefined || STRING_TYPES.has(type)) return String(raw);
  return String(raw);
}

function splitListInput(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseJsonValue(fieldId: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new AtlassianFieldError(
      `${fieldId} was given a json: value that is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "field_value_invalid",
      { field: fieldId }
    );
  }
}

/** Coerces one raw value to the shape the field's schema requires, rather than guessing from the input. */
export function coerceJiraFieldValue(fieldId: string, field: JiraEditMetaField, raw: unknown): unknown {
  // null clears the field, which is how Jira takes "remove this value".
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.startsWith(JSON_VALUE_PREFIX)) return parseJsonValue(fieldId, raw.slice(JSON_VALUE_PREFIX.length));

  // A document a caller already built, like any other object value, is taken as the API shape.
  if (isAdfField(field)) return typeof raw === "string" ? markdownToAdf(raw) : raw;
  if (isSprintField(field)) {
    return typeof raw === "object" ? raw : coerceNumber(fieldId, field, raw);
  }

  const type = field.schema?.type;
  if (type === "array") {
    const items = field.schema?.items;
    return splitListInput(raw).map((entry) => (items === "string" ? String(entry) : coerceScalar(fieldId, field, items, entry)));
  }
  return coerceScalar(fieldId, field, type, raw);
}

/**
 * Resolves a field id or display name against a screen's fields. `subject` names the screen in the
 * error, since the same lookup backs an issue's edit screen and an issue type's create screen.
 */
export function resolveJiraField(meta: JiraIssueEditMeta, input: string, subject = "this issue"): { fieldId: string; field: JiraEditMetaField } {
  const direct = meta.fields[input];
  if (direct !== undefined) return { fieldId: input, field: direct };

  const wanted = input.trim().toLowerCase();
  const matches = Object.entries(meta.fields).filter(([, field]) => field.name?.trim().toLowerCase() === wanted);
  if (matches.length === 1) {
    const [fieldId, field] = matches[0] as [string, JiraEditMetaField];
    return { fieldId, field };
  }
  if (matches.length > 1) {
    throw new AtlassianFieldError(
      `"${input}" matches more than one field on ${subject}; use the field id`,
      "field_ambiguous",
      { field: input, candidates: matches.map(([id, field]) => ({ id, name: field.name })) }
    );
  }

  // Jira rejects the whole edit when one field is unsettable on the issue type (Story Points is
  // absent from Sub-task, Epic, and Jira Task screens), so the settable list is the recovery path.
  throw new AtlassianFieldError(
    `"${input}" is not a field that can be set on ${subject}`,
    "field_not_settable",
    { field: input, settableFields: listSettableJiraFields(meta) }
  );
}

/** Resolves and coerces every requested edit into the `fields` body Jira expects. */
export function planJiraIssueFieldEdits(meta: JiraIssueEditMeta, edits: JiraFieldEdits, subject = "this issue"): JiraIssueEditPlan {
  const entries = Object.entries(edits);
  if (entries.length === 0) throw new AtlassianFieldError("Provide at least one field to edit", "field_required");

  const fields: Record<string, unknown> = {};
  const resolved: JiraResolvedFieldEdit[] = [];
  for (const [input, raw] of entries) {
    const { fieldId, field } = resolveJiraField(meta, input, subject);
    if (fieldId in fields) {
      throw new AtlassianFieldError(`${fieldId} was given more than once`, "field_duplicated", { field: fieldId });
    }
    const value = coerceJiraFieldValue(fieldId, field, raw);
    fields[fieldId] = value;
    resolved.push({ input, fieldId, name: field.name, type: field.schema?.type, value });
  }
  return { fields, resolved };
}

/** Every field the create screen requires and will not fill in itself. */
export function listRequiredJiraFields(meta: JiraIssueEditMeta): JiraSettableField[] {
  return Object.entries(meta.fields)
    .filter(([id, field]) => field.required === true && field.hasDefaultValue !== true && id !== "project" && id !== "issuetype")
    .map(([id, field]) => ({ id, name: field.name, type: field.schema?.type }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Required fields the planned payload does not set. Reported before the create so the caller gets
 * the field list and its options back in one round trip rather than a bare Jira 400.
 */
export function listMissingRequiredJiraFields(meta: JiraIssueEditMeta, plannedFieldIds: readonly string[]): JiraRequiredFieldGap[] {
  const planned = new Set(plannedFieldIds);
  return listRequiredJiraFields(meta)
    .filter((field) => !planned.has(field.id))
    .map((field) => {
      const allowed = allowedValueLabels(meta.fields[field.id] ?? {});
      return allowed.length > 0 ? { ...field, allowedValues: allowed } : field;
    });
}
