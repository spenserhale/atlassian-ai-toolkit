import { AtlassianConfigSchema } from "./types.js";
import type { AtlassianConfig } from "./types.js";

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function resolveConfig(overrides: Partial<AtlassianConfig> = {}): AtlassianConfig {
  return AtlassianConfigSchema.parse({
    siteUrl: overrides.siteUrl ?? process.env.ATLASSIAN_SITE_URL ?? "",
    email: overrides.email ?? process.env.ATLASSIAN_EMAIL ?? "",
    apiToken: overrides.apiToken ?? process.env.ATLASSIAN_API_TOKEN ?? "",
    storyPointsField: overrides.storyPointsField ?? optional(process.env.ATLASSIAN_STORY_POINTS_FIELD),
  });
}
