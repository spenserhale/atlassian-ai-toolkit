import { buildCommand } from "@stricli/core";
import { bunSecretStore, loadCredentials } from "@atlassian-ai-toolkit/sdk";
import { runCommand } from "../../errors.js";
import { migrateCredentials } from "../../lib/auth.js";
import { dryRunFlag, emit, jsonFlag } from "./shared.js";

interface AuthMigrateFlags {
  readonly overwrite: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
}

export const authMigrateCommand = buildCommand({
  docs: {
    brief: "Copy plaintext credentials from .env files into the keychain",
    fullDescription:
      "Stores every credential whose active source is a .env file in the OS keychain, skipping keys " +
      "already there unless --overwrite. Process-environment values (op run, CI) are left alone. " +
      "Files are not edited: remove the lines in the listed clean_up files yourself, because a .env " +
      "value keeps overriding the keychain until you do.",
  },
  parameters: {
    flags: {
      overwrite: { kind: "boolean", brief: "Replace keys that already exist in the keychain", default: false },
      ...dryRunFlag,
      ...jsonFlag,
    },
  },
  async func(this: void, flags: AuthMigrateFlags) {
    await runCommand(flags.json, async () => {
      const store = bunSecretStore();
      const credentials = await loadCredentials({ secretStore: null });
      const result = await migrateCredentials({ store, credentials, dryRun: flags["dry-run"], overwrite: flags.overwrite });
      emit(result, flags.json, () =>
        [
          ...(result.credentials.length === 0
            ? ["nothing to migrate: no credentials come from .env files"]
            : result.credentials.map((row) => `${row.action} ${row.key} (from ${row.from})`)),
          ...(result.clean_up.length > 0
            ? [
                "",
                "remove the migrated keys from these files; a .env value keeps overriding the keychain until you do:",
                ...result.clean_up.map((file) => `  ${file}`),
              ]
            : []),
        ].join("\n")
      );
    });
  },
});
