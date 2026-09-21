import { AtlassianFieldError } from "./errors.js";
import type {
  JiraEditMetaField,
  JiraFieldEdits,
  JiraIssueEditMeta,
  JiraIssueEditPlan,
  JiraResolvedFieldEdit,
  JiraSettableField,
} from "./types.js";

/** Prefix that hands a raw JSON value straight to Jira, for shapes the coercion table doesn't cover. */
const JSON_VALUE_PREFIX = "json:";

/** Field schema types whose edit payload is `{ name: ... }`. */
const NAME_KEYED_TYPES = new Set(["priority", "resolution", "issuetype", "status", "securitylevel", "version", "component", "group"]);

/** Field schema types whose value is sent as a bare string. */
const STRING_TYPES = new Set(["string", "date", "datetime", "any"]);

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

  const type = field.schema?.type;
  if (type === "array") {
    const items = field.schema?.items;
    return splitListInput(raw).map((entry) => (items === "string" ? String(entry) : coerceScalar(fieldId, field, items, entry)));
  }
  return coerceScalar(fieldId, field, type, raw);
}

/** Resolves a field id or display name against the issue's edit screen. */
export function resolveJiraField(meta: JiraIssueEditMeta, input: string): { fieldId: string; field: JiraEditMetaField } {
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
      `"${input}" matches more than one field on this issue; use the field id`,
      "field_ambiguous",
      { field: input, candidates: matches.map(([id, field]) => ({ id, name: field.name })) }
    );
  }

  // Jira rejects the whole edit when one field is unsettable on the issue type (Story Points is
  // absent from Sub-task, Epic, and Jira Task screens), so the settable list is the recovery path.
  throw new AtlassianFieldError(
    `"${input}" is not a field that can be set on this issue`,
    "field_not_settable",
    { field: input, settableFields: listSettableJiraFields(meta) }
  );
}

/** Resolves and coerces every requested edit into the `fields` body Jira expects. */
export function planJiraIssueFieldEdits(meta: JiraIssueEditMeta, edits: JiraFieldEdits): JiraIssueEditPlan {
  const entries = Object.entries(edits);
  if (entries.length === 0) throw new AtlassianFieldError("Provide at least one field to edit", "field_required");

  const fields: Record<string, unknown> = {};
  const resolved: JiraResolvedFieldEdit[] = [];
  for (const [input, raw] of entries) {
    const { fieldId, field } = resolveJiraField(meta, input);
    if (fieldId in fields) {
      throw new AtlassianFieldError(`${fieldId} was given more than once`, "field_duplicated", { field: fieldId });
    }
    const value = coerceJiraFieldValue(fieldId, field, raw);
    fields[fieldId] = value;
    resolved.push({ input, fieldId, name: field.name, type: field.schema?.type, value });
  }
  return { fields, resolved };
}
