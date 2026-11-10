import { AtlassianConfigError } from "./errors.js";

/** Service name every keychain entry is stored under. */
export const KEYCHAIN_SERVICE = "atlassian-ai-toolkit";

/** Env var that turns the keychain lookup off (`0`, `false`, `no`, or `off`). */
export const KEYCHAIN_SWITCH = "ATLASSIAN_KEYCHAIN";

/**
 * A credential store keyed by env-var name (for example `ATLASSIAN_API_TOKEN`). The default
 * implementation is the OS keychain via `Bun.secrets`; tests inject an in-memory store.
 */
export interface SecretStore {
  readonly description: string;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** Resources `auth` commands act on. Atlassian Cloud has one: the site, account email, and API token. */
export const CREDENTIAL_RESOURCES = ["atlassian"] as const;
export type CredentialResource = (typeof CREDENTIAL_RESOURCES)[number];

/**
 * Keychain entry names per resource, named exactly like their env vars. The site URL and email are
 * not secret, but they are stored alongside the token so the CLI and MCP server need no env at all.
 */
const RESOURCE_CREDENTIAL_KEYS: Record<CredentialResource, readonly string[]> = {
  atlassian: ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"],
};

export const CREDENTIAL_KEYS: readonly string[] = CREDENTIAL_RESOURCES.flatMap((id) => RESOURCE_CREDENTIAL_KEYS[id]);

/** Keys whose values are secret, so prompts hide them. The rest echo as they are typed. */
export const SECRET_CREDENTIAL_KEYS: readonly string[] = ["ATLASSIAN_API_TOKEN"];

export function resourceCredentialKeys(resource: CredentialResource): readonly string[] {
  return RESOURCE_CREDENTIAL_KEYS[resource];
}

export function resourceForCredentialKey(key: string): CredentialResource | undefined {
  return CREDENTIAL_RESOURCES.find((id) => RESOURCE_CREDENTIAL_KEYS[id].includes(key));
}

interface BunSecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

function bunSecretsApi(): BunSecretsApi | undefined {
  const bun = (globalThis as { Bun?: { secrets?: BunSecretsApi } }).Bun;
  return bun?.secrets;
}

/** The OS keychain (macOS Keychain, libsecret, Windows Credential Manager) via Bun.secrets. */
export function bunSecretStore(service: string = KEYCHAIN_SERVICE): SecretStore {
  const api = (): BunSecretsApi => {
    const secrets = bunSecretsApi();
    if (!secrets) {
      throw new AtlassianConfigError(
        "The OS keychain is not available in this runtime",
        "Run the toolkit with Bun 1.3 or newer, or set credentials through env, .env, or op run."
      );
    }
    return secrets;
  };
  const wrap = async <T>(action: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AtlassianConfigError) throw error;
      throw new AtlassianConfigError(
        `Could not ${action} the OS keychain`,
        "On macOS, unlock the login keychain and allow access when prompted. On Linux, start a " +
          "Secret Service daemon (GNOME Keyring or KWallet). Otherwise set credentials through env or op run.",
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  return {
    description: `os-keychain:${service}`,
    get: (name) => wrap("read from", () => api().get({ service, name })),
    set: (name, value) => wrap("write to", () => api().set({ service, name, value })),
    delete: (name) => wrap("delete from", () => api().delete({ service, name })),
  };
}

export type KeychainStatus = "ok" | "disabled" | "unavailable";

export interface KeychainReadResult {
  status: KeychainStatus;
  values: Record<string, string>;
  error?: string;
}

/** The underlying reason a store call failed, without the generic wrapper message. */
export function keychainErrorReason(error: unknown): string {
  if (error instanceof AtlassianConfigError) return error.reason ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the given credential names in parallel. A store failure is reported as `unavailable` instead
 * of thrown, so a missing keychain never breaks a command that has credentials from elsewhere.
 */
export async function readKeychainValues(store: SecretStore, names: readonly string[]): Promise<KeychainReadResult> {
  try {
    const entries = await Promise.all(names.map(async (name) => [name, await store.get(name)] as const));
    const values: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (value) values[name] = value;
    }
    return { status: "ok", values };
  } catch (error) {
    return { status: "unavailable", values: {}, error: keychainErrorReason(error) };
  }
}
