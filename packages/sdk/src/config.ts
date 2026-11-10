import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  bunSecretStore,
  CREDENTIAL_KEYS,
  KEYCHAIN_SWITCH,
  readKeychainValues,
  type KeychainStatus,
  type SecretStore,
} from "./secrets.js";
import { AtlassianConfigSchema } from "./types.js";
import type { AtlassianConfig } from "./types.js";

export type Env = Record<string, string | undefined>;

export interface KeychainState {
  status: KeychainStatus;
  error?: string;
}

export interface ResolveConfigOptions {
  /** Directory to look for `.env` files from (walking up). Defaults to the process cwd. */
  cwd?: string;
  /** Process environment to read. Defaults to `process.env`. */
  env?: Env;
  /** Credentials already read from the OS keychain; see loadConfig(). */
  keychainValues?: Record<string, string>;
  /** Keychain lookup status to report; defaults to disabled. */
  keychain?: KeychainState;
}

export interface LoadConfigOptions extends Omit<ResolveConfigOptions, "keychainValues" | "keychain"> {
  /** Explicit values that win over every other source. */
  overrides?: Partial<AtlassianConfig>;
  /** Store to read credentials from. Defaults to the OS keychain; pass null to skip it. */
  secretStore?: SecretStore | null;
}

/**
 * Where each credential came from, without validating it. `sources` labels are `override`, `env`,
 * `envfile:<path>`, `keychain`, or `missing`.
 */
export interface CredentialResolution {
  values: Record<string, string | undefined>;
  sources: Record<string, string>;
  keychain: KeychainState;
  envFiles: string[];
  cwd: string;
}

export type ResolvedConfig = AtlassianConfig & {
  credentialSources: Record<string, string>;
  /** Whether the OS keychain was consulted for credentials. */
  keychain: KeychainState;
  envFiles: string[];
};

interface EnvFileData {
  files: string[];
  values: Env;
  sources: Record<string, string>;
}

interface Picked {
  value: string;
  source: string;
}

const CONFIG_KEY_ENV: Record<"siteUrl" | "email" | "apiToken", string> = {
  siteUrl: "ATLASSIAN_SITE_URL",
  email: "ATLASSIAN_EMAIL",
  apiToken: "ATLASSIAN_API_TOKEN",
};

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Numeric env values must be positive integers. */
function optionalNumber(value: string | undefined): number | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("ATLASSIAN_JIRA_BOARD_ID must be a positive integer");
  }
  return parsed;
}

/**
 * Process env first, then the nearest `.env`. Bun loads the cwd `.env` into `process.env` on its
 * own, so a process value equal to the `.env` value is reported as coming from that file.
 */
function picker(env: Env, envFile: EnvFileData): (name: string) => Picked | undefined {
  return (name) => {
    const fromProcess = nonEmpty(env[name]);
    const fromFile = nonEmpty(envFile.values[name]);
    if (fromFile !== undefined && (fromProcess === undefined || fromProcess === fromFile)) {
      return { value: fromFile, source: `envfile:${envFile.sources[name] ?? "unknown"}` };
    }
    if (fromProcess !== undefined) return { value: fromProcess, source: "env" };
    return undefined;
  };
}

function overrideFor(key: string, overrides: Partial<AtlassianConfig>): string | undefined {
  const field = (Object.keys(CONFIG_KEY_ENV) as Array<keyof typeof CONFIG_KEY_ENV>).find((k) => CONFIG_KEY_ENV[k] === key);
  return field === undefined ? undefined : nonEmpty(overrides[field]);
}

function keychainDisabled(env: Env, envFile: EnvFileData): boolean {
  const value = env[KEYCHAIN_SWITCH] ?? envFile.values[KEYCHAIN_SWITCH] ?? "";
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * Resolve each credential without validating it, so `auth` and `config show` work while credentials
 * are still incomplete. Precedence: overrides > process env > nearest `.env` > keychain.
 */
export function resolveCredentials(overrides: Partial<AtlassianConfig> = {}, options: ResolveConfigOptions = {}): CredentialResolution {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const envFile = readEnvFiles(cwd);
  const pick = picker(env, envFile);
  const keychainValues = options.keychainValues ?? {};

  const values: Record<string, string | undefined> = {};
  const sources: Record<string, string> = {};
  for (const key of CREDENTIAL_KEYS) {
    const override = overrideFor(key, overrides);
    if (override !== undefined) {
      values[key] = override;
      sources[key] = "override";
      continue;
    }
    const picked = pick(key);
    if (picked) {
      values[key] = picked.value;
      sources[key] = picked.source;
      continue;
    }
    const stored = nonEmpty(keychainValues[key]);
    if (stored !== undefined) {
      values[key] = stored;
      sources[key] = "keychain";
      continue;
    }
    values[key] = undefined;
    sources[key] = "missing";
  }
  return { values, sources, keychain: options.keychain ?? { status: "disabled" }, envFiles: envFile.files, cwd };
}

/**
 * Synchronous config resolution from overrides, the process env, `.env` files, and keychain values
 * already read by loadConfig(). Throws when the result is not a usable config.
 */
export function resolveConfig(overrides: Partial<AtlassianConfig> = {}, options: ResolveConfigOptions = {}): ResolvedConfig {
  const credentials = resolveCredentials(overrides, options);
  const env = options.env ?? process.env;
  const pick = picker(env, readEnvFiles(credentials.cwd));
  const config = AtlassianConfigSchema.parse({
    siteUrl: credentials.values.ATLASSIAN_SITE_URL ?? "",
    email: credentials.values.ATLASSIAN_EMAIL ?? "",
    apiToken: credentials.values.ATLASSIAN_API_TOKEN ?? "",
    storyPointsField: overrides.storyPointsField ?? pick("ATLASSIAN_STORY_POINTS_FIELD")?.value,
    jiraBoardId: overrides.jiraBoardId ?? optionalNumber(pick("ATLASSIAN_JIRA_BOARD_ID")?.value),
    jiraProject: overrides.jiraProject ?? pick("ATLASSIAN_JIRA_PROJECT")?.value,
  });
  return { ...config, credentialSources: credentials.sources, keychain: credentials.keychain, envFiles: credentials.envFiles };
}

/**
 * resolveCredentials() plus the OS keychain. Only credentials that overrides, the process env, and
 * `.env` files did not supply are looked up, so an explicit value never triggers a keychain prompt.
 * Set ATLASSIAN_KEYCHAIN=0 (in env or `.env`) to skip the lookup entirely.
 */
export async function loadCredentials(options: LoadConfigOptions = {}): Promise<CredentialResolution> {
  const { keychainValues, keychain } = await readKeychain(options);
  const { overrides, secretStore: _store, ...resolveOptions } = options;
  return resolveCredentials(overrides, { ...resolveOptions, keychainValues, keychain });
}

/** resolveConfig() plus the OS keychain; the async entry point every CLI command and MCP tool uses. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const { keychainValues, keychain } = await readKeychain(options);
  const { overrides, secretStore: _store, ...resolveOptions } = options;
  return resolveConfig(overrides, { ...resolveOptions, keychainValues, keychain });
}

async function readKeychain(options: LoadConfigOptions): Promise<{ keychainValues: Record<string, string>; keychain: KeychainState }> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const envFile = readEnvFiles(cwd);
  if (options.secretStore === null || keychainDisabled(env, envFile)) {
    return { keychainValues: {}, keychain: { status: "disabled" } };
  }
  const pick = picker(env, envFile);
  const overrides = options.overrides ?? {};
  const missing = CREDENTIAL_KEYS.filter((key) => overrideFor(key, overrides) === undefined && pick(key) === undefined);
  if (missing.length === 0) return { keychainValues: {}, keychain: { status: "ok" } };

  const result = await readKeychainValues(options.secretStore ?? bunSecretStore(), missing);
  return {
    keychainValues: result.values,
    keychain: result.error === undefined ? { status: result.status } : { status: result.status, error: result.error },
  };
}

function readEnvFiles(cwd: string): EnvFileData {
  const files: string[] = [];
  let current = cwd;
  while (true) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) files.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Nearest .env wins, so apply parent files first.
  files.reverse();

  const values: Env = {};
  const sources: Record<string, string> = {};
  for (const file of files) {
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      values[key] = value;
      sources[key] = file;
    }
  }
  return { files, values, sources };
}

function parseEnvFile(path: string): Env {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const values: Env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const unexported = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = unexported.indexOf("=");
    if (equals <= 0) continue;
    const key = unexported.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = unexported.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    values[key] = value.replace(/\\n/g, "\n");
  }
  return values;
}

export interface RedactedConfig {
  schema_version: "1";
  cwd: string;
  env_files: string[];
  credentials: Record<string, "set" | "missing">;
  credential_sources: Record<string, string>;
  keychain: KeychainState;
  configured: boolean;
}

/** Credential state with every value replaced by `set` or `missing`; safe to print or return to an agent. */
export function redactedConfig(credentials: CredentialResolution): RedactedConfig {
  const state: Record<string, "set" | "missing"> = {};
  for (const key of CREDENTIAL_KEYS) state[key] = credentials.values[key] ? "set" : "missing";
  return {
    schema_version: "1",
    cwd: credentials.cwd,
    env_files: credentials.envFiles,
    credentials: state,
    credential_sources: credentials.sources,
    keychain: credentials.keychain,
    configured: CREDENTIAL_KEYS.every((key) => Boolean(credentials.values[key])),
  };
}
