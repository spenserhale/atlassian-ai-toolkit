import { buildCommand } from "@stricli/core";
import { bunSecretStore, loadCredentials, SECRET_CREDENTIAL_KEYS } from "@atlassian-ai-toolkit/sdk";
import { runCommand, UsageError } from "../../errors.js";
import { parseResource, selectCredentialKeys, setCredentials } from "../../lib/auth.js";
import { promptLine, readAllStdin, stdinIsInteractive } from "../../lib/prompt.js";
import { dryRunFlag, emit, jsonFlag, keyFlag, resourcePositional } from "./shared.js";

interface AuthSetFlags {
  readonly key?: string;
  readonly stdin: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
}

export const authSetCommand = buildCommand({
  docs: {
    brief: "Store credentials in the OS keychain (prompt, or --stdin)",
    fullDescription:
      "Saves each credential under keychain service `atlassian-ai-toolkit`, named by its env var " +
      "(ATLASSIAN_SITE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN). On a terminal it prompts for each " +
      "key; the API token is hidden as you type. For scripts and agents, pipe one value with --stdin " +
      "and name it with --key. A value is never accepted as an argument, so it stays out of shell " +
      "history and process listings. Env vars and .env files still take precedence over the keychain; " +
      "the output flags a stored value that one of them shadows.",
  },
  parameters: {
    positional: resourcePositional,
    flags: {
      ...keyFlag,
      stdin: { kind: "boolean", brief: "Read the value from stdin instead of prompting (non-interactive)", default: false },
      ...dryRunFlag,
      ...jsonFlag,
    },
  },
  async func(this: void, flags: AuthSetFlags, resourceArg: string) {
    await runCommand(flags.json, async () => {
      const resource = parseResource(resourceArg);
      const keys = selectCredentialKeys(resource, flags.key);

      let readValue: (key: string) => Promise<string>;
      if (flags.stdin) {
        if (keys.length > 1) {
          throw new UsageError(
            `${resource} uses ${keys.length} keys; --stdin stores one per call`,
            `Run once per key: ... | atlassian auth set ${resource} --key ${keys[keys.length - 1]} --stdin`,
            keys
          );
        }
        const piped = await readAllStdin();
        readValue = async () => piped;
      } else {
        if (!stdinIsInteractive()) {
          throw new UsageError(
            "No terminal to prompt on",
            `Pipe the value instead: ... | atlassian auth set ${resource} --key ${keys[keys.length - 1]} --stdin`
          );
        }
        readValue = (key) => promptLine(`${key}: `, { echo: !SECRET_CREDENTIAL_KEYS.includes(key) });
      }

      const credentials = await loadCredentials({ secretStore: null });
      const result = await setCredentials({
        resource,
        keys,
        readValue,
        store: bunSecretStore(),
        credentials,
        dryRun: flags["dry-run"],
      });
      emit(result, flags.json, () =>
        result.credentials
          .map(
            (row) =>
              `${row.action} ${row.key} in ${result.store}` +
              (row.shadowed_by ? ` (warning: ${row.shadowed_by} still overrides it)` : "")
          )
          .join("\n")
      );
    });
  },
});
