import type { JiraResolvedFieldEdit } from "@atlassian-ai-toolkit/sdk";

/** Splits `customfield_13841=Support` at the first `=` so values can contain their own. */
export function parseFieldAssignment(assignment: string): [string, string] {
  const separator = assignment.indexOf("=");
  if (separator <= 0) throw new Error(`--field must be <id|name>=<value> (got: "${assignment}")`);
  const field = assignment.slice(0, separator).trim();
  if (field.length === 0) throw new Error(`--field must be <id|name>=<value> (got: "${assignment}")`);
  return [field, assignment.slice(separator + 1)];
}

/**
 * Collects repeated `--field` flags. A repeated field is rejected rather than silently keeping the
 * last value; a list field takes a comma-separated value instead (`--field labels=audit,login`).
 */
export function parseFieldFlags(assignments: readonly string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const [field, value] = parseFieldAssignment(assignment);
    if (field in fields) throw new Error(`--field ${field} was given more than once; pass a comma-separated value for a list field`);
    fields[field] = value;
  }
  return fields;
}

export function formatResolved(resolved: readonly JiraResolvedFieldEdit[]): string[] {
  return resolved.map((edit) => `- ${edit.fieldId}${edit.name ? ` (${edit.name})` : ""}: ${JSON.stringify(edit.value)}`);
}
