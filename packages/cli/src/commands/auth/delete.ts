import { buildCommand } from "@stricli/core";
import { bunSecretStore } from "@atlassian-ai-toolkit/sdk";
import { runCommand, UsageError } from "../../errors.js";
import { deleteCredentials, parseResource, selectCredentialKeys } from "../../lib/auth.js";
import { dryRunFlag, emit, jsonFlag, keyFlag, resourcePositional } from "./shared.js";

interface AuthDeleteFlags {
  readonly key?: string;
  readonly yes: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
}

export const authDeleteCommand = buildCommand({
  docs: {
    brief: "Remove credentials from the OS keychain (requires --yes)",
    fullDescription:
      "Deletes the resource's keychain entries, or only --key. Values set through env or .env files are not touched.",
  },
  parameters: {
    positional: resourcePositional,
    flags: {
      ...keyFlag,
      yes: { kind: "boolean", brief: "Confirm the deletion", default: false },
      ...dryRunFlag,
      ...jsonFlag,
    },
  },
  async func(this: void, flags: AuthDeleteFlags, resourceArg: string) {
    await runCommand(flags.json, async () => {
      const resource = parseResource(resourceArg);
      const keys = selectCredentialKeys(resource, flags.key);
      if (!flags.yes && !flags["dry-run"]) {
        throw new UsageError(
          "Deleting a keychain entry needs --yes",
          `Preview with --dry-run, then run: atlassian auth delete ${resource}${flags.key ? ` --key ${keys[0]}` : ""} --yes`
        );
      }
      const result = await deleteCredentials({ resource, keys, store: bunSecretStore(), dryRun: flags["dry-run"] });
      emit(result, flags.json, () => result.credentials.map((row) => `${row.action} ${row.key}`).join("\n"));
    });
  },
});
