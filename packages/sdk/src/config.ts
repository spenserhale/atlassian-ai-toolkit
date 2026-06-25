import { AtlassianConfigSchema } from "./types.js";
import type { AtlassianConfig } from "./types.js";

export function resolveConfig(overrides: Partial<AtlassianConfig> = {}): AtlassianConfig {
  return AtlassianConfigSchema.parse({
    siteUrl: overrides.siteUrl ?? process.env.ATLASSIAN_SITE_URL ?? "",
    email: overrides.email ?? process.env.ATLASSIAN_EMAIL ?? "",
    apiToken: overrides.apiToken ?? process.env.ATLASSIAN_API_TOKEN ?? "",
  });
}
