import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadCredentials, redactedConfig, resolveConfig } from "../src/config.js";
import { CREDENTIAL_KEYS, readKeychainValues, type SecretStore } from "../src/secrets.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlassian-secrets-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FULL = {
  ATLASSIAN_SITE_URL: "https://keychain.atlassian.net",
  ATLASSIAN_EMAIL: "keychain@example.com",
  ATLASSIAN_API_TOKEN: "keychain-token",
};

function memoryStore(initial: Record<string, string> = {}): SecretStore & { requested: string[] } {
  const values = new Map(Object.entries(initial));
  const requested: string[] = [];
  return {
    description: "memory",
    requested,
    async get(name) {
      requested.push(name);
      return values.get(name) ?? null;
    },
    async set(name, value) {
      values.set(name, value);
    },
    async delete(name) {
      return values.delete(name);
    },
  };
}

function failingStore(): SecretStore & { calls: number } {
  const store = {
    description: "failing",
    calls: 0,
    async get(): Promise<never> {
      store.calls += 1;
      throw new Error("no secret service");
    },
    async set(): Promise<never> {
      throw new Error("no secret service");
    },
    async delete(): Promise<never> {
      throw new Error("no secret service");
    },
  };
  return store;
}

describe("keychain credential resolution", () => {
  it("resolves credentials from the keychain when env and .env are empty", async () => {
    const config = await loadConfig({ cwd: tempDir(), env: {}, secretStore: memoryStore(FULL) });
    expect(config.siteUrl).toBe(FULL.ATLASSIAN_SITE_URL);
    expect(config.email).toBe(FULL.ATLASSIAN_EMAIL);
    expect(config.apiToken).toBe(FULL.ATLASSIAN_API_TOKEN);
    for (const key of CREDENTIAL_KEYS) expect(config.credentialSources[key]).toBe("keychain");
    expect(config.keychain).toEqual({ status: "ok" });
  });

  it("applies env > .env > keychain precedence", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "ATLASSIAN_EMAIL=dotenv@example.com\nATLASSIAN_API_TOKEN=dotenv-token\n");
    const config = await loadConfig({
      cwd,
      env: { ATLASSIAN_API_TOKEN: "env-token" },
      secretStore: memoryStore(FULL),
    });
    expect(config.apiToken).toBe("env-token");
    expect(config.credentialSources.ATLASSIAN_API_TOKEN).toBe("env");
    expect(config.email).toBe("dotenv@example.com");
    expect(config.credentialSources.ATLASSIAN_EMAIL).toBe(`envfile:${join(cwd, ".env")}`);
    expect(config.siteUrl).toBe(FULL.ATLASSIAN_SITE_URL);
    expect(config.credentialSources.ATLASSIAN_SITE_URL).toBe("keychain");
  });

  it("lets explicit overrides beat every source without asking the keychain for them", async () => {
    const store = memoryStore(FULL);
    const config = await loadConfig({
      cwd: tempDir(),
      env: { ATLASSIAN_API_TOKEN: "env-token" },
      overrides: { apiToken: "override-token" },
      secretStore: store,
    });
    expect(config.apiToken).toBe("override-token");
    expect(config.credentialSources.ATLASSIAN_API_TOKEN).toBe("override");
    expect(store.requested).not.toContain("ATLASSIAN_API_TOKEN");
  });

  it("labels a process value that Bun loaded from the cwd .env as the .env file", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "ATLASSIAN_API_TOKEN=same\n");
    const credentials = await loadCredentials({ cwd, env: { ATLASSIAN_API_TOKEN: "same" }, secretStore: null });
    expect(credentials.sources.ATLASSIAN_API_TOKEN).toBe(`envfile:${join(cwd, ".env")}`);
  });

  it("uses the nearest .env when several directories have one", async () => {
    const parent = tempDir();
    const child = join(parent, "child");
    mkdirSync(child);
    writeFileSync(join(parent, ".env"), "ATLASSIAN_EMAIL=parent@example.com\nATLASSIAN_SITE_URL=https://parent.atlassian.net\n");
    writeFileSync(join(child, ".env"), "ATLASSIAN_EMAIL=child@example.com\n");
    const credentials = await loadCredentials({ cwd: child, env: {}, secretStore: null });
    expect(credentials.values.ATLASSIAN_EMAIL).toBe("child@example.com");
    expect(credentials.values.ATLASSIAN_SITE_URL).toBe("https://parent.atlassian.net");
  });

  it("only asks the store for credentials no other source supplied", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "ATLASSIAN_EMAIL=dotenv@example.com\n");
    const store = memoryStore(FULL);
    await loadConfig({ cwd, env: { ATLASSIAN_SITE_URL: "https://env.atlassian.net" }, secretStore: store });
    expect(store.requested).toEqual(["ATLASSIAN_API_TOKEN"]);
  });

  it("skips the store entirely when env and .env supply everything", async () => {
    const store = memoryStore(FULL);
    const config = await loadConfig({
      cwd: tempDir(),
      env: { ATLASSIAN_SITE_URL: "https://env.atlassian.net", ATLASSIAN_EMAIL: "env@example.com", ATLASSIAN_API_TOKEN: "t" },
      secretStore: store,
    });
    expect(store.requested).toEqual([]);
    expect(config.keychain.status).toBe("ok");
  });

  it("makes no store calls when ATLASSIAN_KEYCHAIN=0 in env", async () => {
    const store = memoryStore(FULL);
    const credentials = await loadCredentials({ cwd: tempDir(), env: { ATLASSIAN_KEYCHAIN: "0" }, secretStore: store });
    expect(store.requested).toEqual([]);
    expect(credentials.keychain).toEqual({ status: "disabled" });
    expect(credentials.sources.ATLASSIAN_API_TOKEN).toBe("missing");
  });

  it("honors ATLASSIAN_KEYCHAIN=off from a .env file", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "ATLASSIAN_KEYCHAIN=off\n");
    const store = memoryStore(FULL);
    const credentials = await loadCredentials({ cwd, env: {}, secretStore: store });
    expect(store.requested).toEqual([]);
    expect(credentials.keychain.status).toBe("disabled");
  });

  it("skips the store when secretStore is null", async () => {
    const credentials = await loadCredentials({ cwd: tempDir(), env: {}, secretStore: null });
    expect(credentials.keychain.status).toBe("disabled");
  });

  it("reports an unavailable store and still resolves env credentials", async () => {
    const store = failingStore();
    const config = await loadConfig({
      cwd: tempDir(),
      env: { ATLASSIAN_SITE_URL: "https://env.atlassian.net", ATLASSIAN_EMAIL: "env@example.com" },
      overrides: { apiToken: "override-token" },
      secretStore: store,
    });
    expect(store.calls).toBe(0);
    const credentials = await loadCredentials({ cwd: tempDir(), env: { ATLASSIAN_EMAIL: "env@example.com" }, secretStore: store });
    expect(credentials.keychain.status).toBe("unavailable");
    expect(credentials.keychain.error).toContain("no secret service");
    expect(credentials.values.ATLASSIAN_EMAIL).toBe("env@example.com");
    expect(config.email).toBe("env@example.com");
  });

  it("keeps resolveConfig synchronous and reports the keychain as disabled", () => {
    const config = resolveConfig(
      {},
      { cwd: tempDir(), env: { ATLASSIAN_SITE_URL: "https://env.atlassian.net", ATLASSIAN_EMAIL: "env@example.com", ATLASSIAN_API_TOKEN: "t" } }
    );
    expect(config.keychain).toEqual({ status: "disabled" });
    expect(config.credentialSources.ATLASSIAN_API_TOKEN).toBe("env");
  });

  it("redacts every credential value", async () => {
    const credentials = await loadCredentials({ cwd: tempDir(), env: {}, secretStore: memoryStore(FULL) });
    const redacted = redactedConfig(credentials);
    expect(redacted.configured).toBe(true);
    expect(redacted.credentials.ATLASSIAN_API_TOKEN).toBe("set");
    expect(JSON.stringify(redacted)).not.toContain(FULL.ATLASSIAN_API_TOKEN);
  });
});

describe("readKeychainValues", () => {
  it("drops empty values and never throws", async () => {
    const ok = await readKeychainValues(memoryStore({ ATLASSIAN_API_TOKEN: "x", ATLASSIAN_EMAIL: "" }), CREDENTIAL_KEYS);
    expect(ok).toEqual({ status: "ok", values: { ATLASSIAN_API_TOKEN: "x" } });
    const failed = await readKeychainValues(failingStore(), CREDENTIAL_KEYS);
    expect(failed.status).toBe("unavailable");
    expect(failed.values).toEqual({});
  });
});
