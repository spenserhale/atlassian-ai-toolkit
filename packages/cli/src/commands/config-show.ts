import { buildCommand, buildRouteMap } from "@stricli/core";
import { loadCredentials, redactedConfig } from "@atlassian-ai-toolkit/sdk";
import { runCommand } from "../errors.js";

interface ConfigShowFlags {
  readonly json: boolean;
}

export const configShowCommand = buildCommand({
  docs: {
    brief: "Show resolved credential sources and keychain status, with values redacted",
  },
  parameters: {
    flags: {
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
  },
  async func(this: void, flags: ConfigShowFlags) {
    await runCommand(flags.json, async () => {
      const config = redactedConfig(await loadCredentials());
      if (flags.json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      const lines = [
        `configured: ${config.configured}`,
        `keychain.status: ${config.keychain.status}${config.keychain.error ? ` (${config.keychain.error})` : ""}`,
        `env_files: ${config.env_files.length > 0 ? config.env_files.join(", ") : "none"}`,
      ];
      for (const [key, state] of Object.entries(config.credentials)) {
        lines.push(`${key}: ${state} (source: ${config.credential_sources[key]})`);
      }
      console.log(lines.join("\n"));
    });
  },
});

export const configRoutes = buildRouteMap({
  routes: { show: configShowCommand },
  docs: { brief: "Inspect resolved configuration" },
});
