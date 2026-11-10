import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCredentials, type SecretStore } from "@atlassian-ai-toolkit/sdk";
import {
  deleteCredentials,
  listCredentials,
  migrateCredentials,
  parseResource,
  selectCredentialKeys,
  setCredentials,
  validateCredentialValue,
} from "../src/lib/auth.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlassian-auth-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    description: "memory",
    values,
    async get(name) {
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

function failingStore(): SecretStore {
  const fail = async (): Promise<never> => {
    throw new Error("no secret service");
  };
  return { description: "failing", get: fail, set: fail, delete: fail };
}

function credentials(env: Record<string, string> = {}, cwd = tempDir()) {
  return resolveCredentials({}, { cwd, env });
}

describe("auth helpers", () => {
  it("validates the resource and --key", () => {
    expect(parseResource("Atlassian")).toBe("atlassian");
    expect(() => parseResource("github")).toThrow("Unknown resource");
    expect(selectCredentialKeys("atlassian", undefined)).toEqual(["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"]);
    expect(selectCredentialKeys("atlassian", "atlassian_api_token")).toEqual(["ATLASSIAN_API_TOKEN"]);
    expect(() => selectCredentialKeys("atlassian", "GITHUB_TOKEN")).toThrow("not a credential");
  });

  it("rejects a malformed site URL or email", () => {
    expect(() => validateCredentialValue("ATLASSIAN_SITE_URL", "not a url")).toThrow("must be a URL");
    expect(() => validateCredentialValue("ATLASSIAN_EMAIL", "nobody")).toThrow("email");
    expect(validateCredentialValue("ATLASSIAN_SITE_URL", " https://x.atlassian.net \n")).toBe("https://x.atlassian.net");
  });
});

describe("setCredentials", () => {
  it("trims and stores the value", async () => {
    const store = memoryStore();
    const result = await setCredentials({
      resource: "atlassian",
      keys: ["ATLASSIAN_API_TOKEN"],
      readValue: async () => "  secret-token\n",
      store,
      credentials: credentials(),
      dryRun: false,
    });
    expect(store.values.get("ATLASSIAN_API_TOKEN")).toBe("secret-token");
    expect(result.credentials).toEqual([{ key: "ATLASSIAN_API_TOKEN", action: "stored" }]);
    expect(result.store).toBe("memory");
  });

  it("writes nothing on --dry-run", async () => {
    const store = memoryStore();
    const result = await setCredentials({
      resource: "atlassian",
      keys: ["ATLASSIAN_API_TOKEN"],
      readValue: async () => "secret-token",
      store,
      credentials: credentials(),
      dryRun: true,
    });
    expect(store.values.size).toBe(0);
    expect(result.dry_run).toBe(true);
    expect(result.credentials[0]?.action).toBe("would_store");
  });

  it("rejects empty input", async () => {
    const store = memoryStore();
    await expect(
      setCredentials({
        resource: "atlassian",
        keys: ["ATLASSIAN_API_TOKEN"],
        readValue: async () => "  \n",
        store,
        credentials: credentials(),
        dryRun: false,
      })
    ).rejects.toThrow("must not be empty");
    expect(store.values.size).toBe(0);
  });

  it("stores nothing when a later value is invalid", async () => {
    const store = memoryStore();
    const answers: Record<string, string> = {
      ATLASSIAN_SITE_URL: "https://x.atlassian.net",
      ATLASSIAN_EMAIL: "bad",
      ATLASSIAN_API_TOKEN: "t",
    };
    await expect(
      setCredentials({
        resource: "atlassian",
        keys: selectCredentialKeys("atlassian", undefined),
        readValue: async (key) => answers[key] ?? "",
        store,
        credentials: credentials(),
        dryRun: false,
      })
    ).rejects.toThrow();
    expect(store.values.size).toBe(0);
  });

  it("reports what still shadows a stored value", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "ATLASSIAN_EMAIL=dotenv@example.com\n");
    const result = await setCredentials({
      resource: "atlassian",
      keys: ["ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "ATLASSIAN_SITE_URL"],
      readValue: async (key) => (key === "ATLASSIAN_EMAIL" ? "me@example.com" : key === "ATLASSIAN_SITE_URL" ? "https://x.atlassian.net" : "t"),
      store: memoryStore(),
      credentials: credentials({ ATLASSIAN_API_TOKEN: "env-token" }, cwd),
      dryRun: true,
    });
    const byKey = Object.fromEntries(result.credentials.map((row) => [row.key, row.shadowed_by]));
    expect(byKey.ATLASSIAN_EMAIL).toBe(`envfile:${join(cwd, ".env")}`);
    expect(byKey.ATLASSIAN_API_TOKEN).toBe("env");
    expect(byKey.ATLASSIAN_SITE_URL).toBeUndefined();
  });
});

describe("listCredentials", () => {
  it("reports keychain state and active source without values", async () => {
    const store = memoryStore({ ATLASSIAN_API_TOKEN: "super-secret-value" });
    const resolved = resolveCredentials(
      {},
      { cwd: tempDir(), env: { ATLASSIAN_EMAIL: "env@example.com" }, keychainValues: { ATLASSIAN_API_TOKEN: "super-secret-value" }, keychain: { status: "ok" } }
    );
    const result = await listCredentials(store, resolved);
    expect(result.keychain_status).toBe("ok");
    const byKey = Object.fromEntries(result.credentials.map((row) => [row.key, row]));
    expect(byKey.ATLASSIAN_API_TOKEN).toMatchObject({ keychain: "set", active_source: "keychain" });
    expect(byKey.ATLASSIAN_EMAIL).toMatchObject({ keychain: "missing", active_source: "env" });
    expect(byKey.ATLASSIAN_SITE_URL).toMatchObject({ keychain: "missing", active_source: "missing" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("env@example.com");
  });

  it("reports unknown keychain state when the store is unavailable", async () => {
    const result = await listCredentials(failingStore(), credentials());
    expect(result.keychain_status).toBe("unavailable");
    expect(result.keychain_error).toContain("no secret service");
    expect(result.credentials.every((row) => row.keychain === "unknown")).toBe(true);
  });
});

describe("deleteCredentials", () => {
  it("reports deleted and not_found, and deletes nothing on --dry-run", async () => {
    const store = memoryStore({ ATLASSIAN_API_TOKEN: "t" });
    const preview = await deleteCredentials({ resource: "atlassian", keys: ["ATLASSIAN_API_TOKEN"], store, dryRun: true });
    expect(preview.credentials).toEqual([{ key: "ATLASSIAN_API_TOKEN", action: "would_delete" }]);
    expect(store.values.has("ATLASSIAN_API_TOKEN")).toBe(true);

    const result = await deleteCredentials({ resource: "atlassian", keys: ["ATLASSIAN_API_TOKEN", "ATLASSIAN_EMAIL"], store, dryRun: false });
    expect(result.credentials).toEqual([
      { key: "ATLASSIAN_API_TOKEN", action: "deleted" },
      { key: "ATLASSIAN_EMAIL", action: "not_found" },
    ]);
  });
});

describe("migrateCredentials", () => {
  it("stores .env credentials, skips existing ones, ignores env, and lists files to clean up", async () => {
    const cwd = tempDir();
    const envPath = join(cwd, ".env");
    writeFileSync(envPath, "ATLASSIAN_SITE_URL=https://dotenv.atlassian.net\nATLASSIAN_EMAIL=dotenv@example.com\n");
    const store = memoryStore({ ATLASSIAN_EMAIL: "kept@example.com" });
    const resolved = credentials({ ATLASSIAN_API_TOKEN: "env-token" }, cwd);

    const result = await migrateCredentials({ store, credentials: resolved, dryRun: false, overwrite: false });
    expect(result.credentials).toEqual([
      { resource: "atlassian", key: "ATLASSIAN_SITE_URL", from: `envfile:${envPath}`, action: "stored" },
      { resource: "atlassian", key: "ATLASSIAN_EMAIL", from: `envfile:${envPath}`, action: "skipped_exists" },
    ]);
    expect(store.values.get("ATLASSIAN_SITE_URL")).toBe("https://dotenv.atlassian.net");
    expect(store.values.get("ATLASSIAN_EMAIL")).toBe("kept@example.com");
    expect(store.values.has("ATLASSIAN_API_TOKEN")).toBe(false);
    expect(result.clean_up).toEqual([envPath]);
  });

  it("overwrites with --overwrite and writes nothing on --dry-run", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "ATLASSIAN_EMAIL=dotenv@example.com\n");
    const store = memoryStore({ ATLASSIAN_EMAIL: "kept@example.com" });
    const preview = await migrateCredentials({ store, credentials: credentials({}, cwd), dryRun: true, overwrite: true });
    expect(preview.credentials[0]?.action).toBe("would_store");
    expect(store.values.get("ATLASSIAN_EMAIL")).toBe("kept@example.com");

    await migrateCredentials({ store, credentials: credentials({}, cwd), dryRun: false, overwrite: true });
    expect(store.values.get("ATLASSIAN_EMAIL")).toBe("dotenv@example.com");
  });
});
