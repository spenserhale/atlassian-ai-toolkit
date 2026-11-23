import { AtlassianFieldError } from "./errors.js";
import { listSettableJiraFields } from "./jira-fields.js";
import type { JiraIssueEditMeta, JiraTransition, JiraTransitionSummary } from "./types.js";

/** The transition screen as an edit-metadata map, so field resolution and coercion are shared with `edit`. */
export function jiraTransitionScreen(transition: JiraTransition): JiraIssueEditMeta {
  return { fields: transition.fields ?? {} };
}

export function summarizeJiraTransition(transition: JiraTransition): JiraTransitionSummary {
  const fields = listSettableJiraFields(jiraTransitionScreen(transition));
  const required = new Set(Object.entries(transition.fields ?? {}).filter(([, field]) => field.required === true).map(([id]) => id));
  const category = transition.to.statusCategory?.name ?? transition.to.statusCategory?.key;
  return {
    id: transition.id,
    name: transition.name,
    to: { id: transition.to.id, name: transition.to.name, ...(category !== undefined ? { category } : {}) },
    hasScreen: transition.hasScreen ?? fields.length > 0,
    fields,
    requiredFields: fields.filter((field) => required.has(field.id)),
  };
}

function describeTransition(transition: JiraTransition): string {
  return transition.name === transition.to.name ? `${transition.id} ${transition.name}` : `${transition.id} ${transition.name} -> ${transition.to.name}`;
}

function availableList(transitions: readonly JiraTransition[]): Array<{ id: string; name: string; to: string }> {
  return transitions.map((transition) => ({ id: transition.id, name: transition.name, to: transition.to.name }));
}

/**
 * Picks the transition a caller asked for by transition id, then transition name, then target status
 * name, so `--to Done` works whether the workflow calls the move "Done", "Close", or "Resolve". Names
 * match case-insensitively. A miss or a tie fails with the available transitions in the details.
 */
export function resolveJiraTransition(transitions: readonly JiraTransition[], input: string, issue: string): JiraTransition {
  const wanted = input.trim();
  if (wanted.length === 0) throw new AtlassianFieldError("Provide a transition or target status to move the issue to", "transition_required");

  const byId = transitions.find((transition) => transition.id === wanted);
  if (byId !== undefined) return byId;

  const lower = wanted.toLowerCase();
  const byName = transitions.filter((transition) => transition.name.trim().toLowerCase() === lower);
  const matches = byName.length > 0 ? byName : transitions.filter((transition) => transition.to.name.trim().toLowerCase() === lower);
  if (matches.length === 1) return matches[0] as JiraTransition;

  if (matches.length > 1) {
    throw new AtlassianFieldError(
      `"${input}" matches more than one transition on ${issue}; use the transition id: ${matches.map(describeTransition).join("; ")}`,
      "transition_ambiguous",
      { transition: input, candidates: availableList(matches) }
    );
  }

  const available = transitions.length > 0 ? transitions.map(describeTransition).join("; ") : "none";
  throw new AtlassianFieldError(
    `"${input}" is not a transition available on ${issue} from its current status. Available: ${available}`,
    "transition_not_available",
    { transition: input, available: availableList(transitions) }
  );
}
