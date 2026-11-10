import { buildCommand } from "@stricli/core";
import { bunSecretStore, loadCredentials } from "@atlassian-ai-toolkit/sdk";
import { runCommand, UsageError } from "../../errors.js";
import { csvCell, listCredentials } from "../../lib/auth.js";
import { jsonFlag } from "./shared.js";

interface AuthListFlags {
  readonly json: boolean;
  readonly csv: boolean;
}

export const authListCommand = buildCommand({
  docs: {
    brief: "Show which credentials are in the keychain and where each active value comes from",
    fullDescription:
      "Lists every credential with its keychain state (set, missing, or unknown when the keychain is " +
      "unavailable) and its active source (env, envfile:<path>, keychain, or missing). Values are " +
      "never printed.",
  },
  parameters: {
    flags: {
      ...jsonFlag,
      csv: { kind: "boolean", brief: "Output as CSV", default: false },
    },
  },
  async func(this: void, flags: AuthListFlags) {
    await runCommand(flags.json, async () => {
      if (flags.json && flags.csv) throw new UsageError("Use only one of --json and --csv");
      const store = bunSecretStore();
      const credentials = await loadCredentials({ secretStore: store });
      const result = await listCredentials(store, credentials);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (flags.csv) {
        const lines = ["resource,key,keychain,active_source"];
        for (const row of result.credentials) {
          lines.push([row.resource, row.key, row.keychain, row.active_source].map(csvCell).join(","));
        }
        console.log(lines.join("\n"));
        return;
      }
      const width = Math.max(...result.credentials.map((row) => row.key.length));
      const lines = [`store: ${result.store} (${result.keychain_status})`];
      if (result.keychain_error) lines.push(`keychain_error: ${result.keychain_error}`);
      for (const row of result.credentials) {
        lines.push(`${row.key.padEnd(width)}  keychain=${row.keychain}  source=${row.active_source}`);
      }
      console.log(lines.join("\n"));
    });
  },
});
