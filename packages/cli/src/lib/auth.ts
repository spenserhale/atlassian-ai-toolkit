import {
  AtlassianConfigSchema,
  CREDENTIAL_KEYS,
  CREDENTIAL_RESOURCES,
  keychainErrorReason,
  resourceCredentialKeys,
  resourceForCredentialKey,
  type CredentialResolution,
  type CredentialResource,
  type SecretStore,
} from "@atlassian-ai-toolkit/sdk";
import { UsageError } from "../errors.js";

export function parseResource(raw: string): CredentialResource {
  const value = raw.trim().toLowerCase();
  if (!(CREDENTIAL_RESOURCES as readonly string[]).includes(value)) {
    throw new UsageError(`Unknown resource: ${raw}`, undefined, CREDENTIAL_RESOURCES);
  }
  return value as CredentialResource;
}

/** The keychain entry names to act on: one --key, or every key the resource uses. */
export function selectCredentialKeys(resource: CredentialResource, key: string | undefined): string[] {
  const keys = resourceCredentialKeys(resource);
  if (key === undefined) return [...keys];
  const normalized = key.trim().toUpperCase();
  if (!keys.includes(normalized)) {
    throw new UsageError(`--key is not a credential for ${resource}: ${key}`, undefined, keys);
  }
  return [normalized];
}

const VALIDATORS: Record<string, { safeParse(value: string): { success: boolean; error?: { issues: Array<{ message: string }> } } }> = {
  ATLASSIAN_SITE_URL: AtlassianConfigSchema.shape.siteUrl,
  ATLASSIAN_EMAIL: AtlassianConfigSchema.shape.email,
};

/** Rejects empty values and catches a malformed site URL or email before it reaches the keychain. */
export function validateCredentialValue(key: string, raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new UsageError(`${key} must not be empty`, "Type the value at the prompt, or pipe it with --stdin.");
  }
  const result = VALIDATORS[key]?.safeParse(value);
  if (result && !result.success) {
    throw new UsageError(result.error?.issues[0]?.message ?? `${key} is not valid`);
  }
  return value;
}

/** Sources that outrank the keychain, so a stored value would be ignored. */
function isShadowingSource(source: string | undefined): boolean {
  return source === "env" || (source?.startsWith("envfile:") ?? false);
}

export interface SetCredentialsInput {
  resource: CredentialResource;
  keys: readonly string[];
  readValue: (key: string) => Promise<string>;
  store: SecretStore;
  /** Credentials resolved without the keychain, to report what still shadows a stored value. */
  credentials: CredentialResolution;
  dryRun: boolean;
}

export interface SetCredentialsResult {
  resource: CredentialResource;
  store: string;
  dry_run: boolean;
  credentials: Array<{ key: string; action: "stored" | "would_store"; shadowed_by?: string }>;
}

/** Reads and validates every value before writing any, so a bad second value stores nothing. */
export async function setCredentials(input: SetCredentialsInput): Promise<SetCredentialsResult> {
  const values: Array<[string, string]> = [];
  for (const key of input.keys) {
    values.push([key, validateCredentialValue(key, await input.readValue(key))]);
  }
  const credentials: SetCredentialsResult["credentials"] = [];
  for (const [key, value] of values) {
    if (!input.dryRun) await input.store.set(key, value);
    const source = input.credentials.sources[key];
    credentials.push({
      key,
      action: input.dryRun ? "would_store" : "stored",
      ...(isShadowingSource(source) ? { shadowed_by: source } : {}),
    });
  }
  return { resource: input.resource, store: input.store.description, dry_run: input.dryRun, credentials };
}

export interface CredentialListRow {
  resource: CredentialResource;
  key: string;
  keychain: "set" | "missing" | "unknown";
  active_source: string;
}

export interface ListCredentialsResult {
  store: string;
  keychain_status: "ok" | "unavailable";
  keychain_error?: string;
  credentials: CredentialListRow[];
}

/** Keychain presence and the winning source for every credential. Values are never included. */
export async function listCredentials(store: SecretStore, credentials: CredentialResolution): Promise<ListCredentialsResult> {
  let stored: Record<string, boolean> | null = null;
  let error: string | undefined;
  try {
    const entries = await Promise.all(CREDENTIAL_KEYS.map(async (key) => [key, Boolean(await store.get(key))] as const));
    stored = Object.fromEntries(entries);
  } catch (caught) {
    error = keychainErrorReason(caught);
  }
  return {
    store: store.description,
    keychain_status: stored ? "ok" : "unavailable",
    ...(error ? { keychain_error: error } : {}),
    credentials: CREDENTIAL_KEYS.map((key) => ({
      resource: resourceForCredentialKey(key) as CredentialResource,
      key,
      keychain: stored ? (stored[key] ? "set" : "missing") : "unknown",
      active_source: credentials.sources[key] ?? "missing",
    })),
  };
}

export interface DeleteCredentialsResult {
  resource: CredentialResource;
  store: string;
  dry_run: boolean;
  credentials: Array<{ key: string; action: "deleted" | "not_found" | "would_delete" }>;
}

export async function deleteCredentials(input: {
  resource: CredentialResource;
  keys: readonly string[];
  store: SecretStore;
  dryRun: boolean;
}): Promise<DeleteCredentialsResult> {
  const credentials: DeleteCredentialsResult["credentials"] = [];
  for (const key of input.keys) {
    if (input.dryRun) {
      credentials.push({ key, action: "would_delete" });
      continue;
    }
    const deleted = await input.store.delete(key);
    credentials.push({ key, action: deleted ? "deleted" : "not_found" });
  }
  return { resource: input.resource, store: input.store.description, dry_run: input.dryRun, credentials };
}

export interface MigrateCredentialsResult {
  store: string;
  dry_run: boolean;
  credentials: Array<{
    resource: CredentialResource;
    key: string;
    from: string;
    action: "stored" | "would_store" | "skipped_exists";
  }>;
  /** Plaintext files that still hold migrated keys; remove the lines yourself. */
  clean_up: string[];
}

/**
 * Copy credentials whose winning source is a `.env` file into the store. Process-environment values
 * are left alone: they usually come from op run or CI and are not plaintext at rest. Files are never
 * edited, and a `.env` value keeps overriding the keychain until the user removes it.
 */
export async function migrateCredentials(input: {
  store: SecretStore;
  credentials: CredentialResolution;
  dryRun: boolean;
  overwrite: boolean;
}): Promise<MigrateCredentialsResult> {
  const rows: MigrateCredentialsResult["credentials"] = [];
  const cleanUp = new Set<string>();
  for (const key of CREDENTIAL_KEYS) {
    const source = input.credentials.sources[key];
    if (!source?.startsWith("envfile:")) continue;
    const value = input.credentials.values[key];
    if (!value) continue;
    const resource = resourceForCredentialKey(key) as CredentialResource;

    if (!input.overwrite && (await input.store.get(key))) {
      rows.push({ resource, key, from: source, action: "skipped_exists" });
      continue;
    }
    if (!input.dryRun) await input.store.set(key, value);
    rows.push({ resource, key, from: source, action: input.dryRun ? "would_store" : "stored" });
    cleanUp.add(source.slice("envfile:".length));
  }
  return { store: input.store.description, dry_run: input.dryRun, credentials: rows, clean_up: [...cleanUp] };
}

export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
