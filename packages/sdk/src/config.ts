import { AtlassianConfigSchema } from "./types.js";
import type { AtlassianConfig } from "./types.js";

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Numeric env values resolve to NaN when malformed, which the config schema rejects with context. */
function optionalNumber(value: string | undefined): number | undefined {
  const raw = optional(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("ATLASSIAN_JIRA_BOARD_ID must be a positive integer");
  }
  return parsed;
}

export function resolveConfig(overrides: Partial<AtlassianConfig> = {}): AtlassianConfig {
  return AtlassianConfigSchema.parse({
    siteUrl: overrides.siteUrl ?? process.env.ATLASSIAN_SITE_URL ?? "",
    email: overrides.email ?? process.env.ATLASSIAN_EMAIL ?? "",
    apiToken: overrides.apiToken ?? process.env.ATLASSIAN_API_TOKEN ?? "",
    storyPointsField: overrides.storyPointsField ?? optional(process.env.ATLASSIAN_STORY_POINTS_FIELD),
    jiraBoardId: overrides.jiraBoardId ?? optionalNumber(process.env.ATLASSIAN_JIRA_BOARD_ID),
  });
}
