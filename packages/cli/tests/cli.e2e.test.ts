import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../src/bin.ts");
const dirs: string[] = [];

// Each test spawns a fresh Bun process.
setDefaultTimeout(20_000);

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlassian-cli-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spawns the CLI with the keychain lookup off and no inherited Atlassian credentials. */
async function runCli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ATLASSIAN_KEYCHAIN: "0" };
  const proc = Bun.spawn(["bun", BIN, ...args], {
    cwd: tempDir(),
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("atlassian auth", () => {
  it("refuses auth set without a terminal unless --stdin is passed", async () => {
    const result = await runCli(["auth", "set", "atlassian"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--stdin");
  });

  it("refuses auth set --stdin for a multi-key resource without --key", async () => {
    const result = await runCli(["auth", "set", "atlassian", "--stdin"], "x\n");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--key ATLASSIAN_API_TOKEN --stdin");
  });

  it("previews auth set --stdin --dry-run without writing or echoing the value", async () => {
    const result = await runCli(["auth", "set", "atlassian", "--key", "ATLASSIAN_API_TOKEN", "--stdin", "--dry-run", "--json"], "dry-run-secret\n");
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.dry_run).toBe(true);
    expect(payload.credentials[0].action).toBe("would_store");
    expect(result.stdout + result.stderr).not.toContain("dry-run-secret");
  });

  it("rejects an empty piped value", async () => {
    const result = await runCli(["auth", "set", "atlassian", "--key", "ATLASSIAN_API_TOKEN", "--stdin", "--dry-run"], "\n");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("must not be empty");
  });

  it("requires --yes for auth delete", async () => {
    const result = await runCli(["auth", "delete", "atlassian"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--yes");
  });

  it("rejects an unknown resource", async () => {
    const result = await runCli(["auth", "delete", "github", "--yes"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown resource");
  });

  it("returns usage errors as JSON on stdout with --json", async () => {
    const result = await runCli(["auth", "delete", "github", "--yes", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "usage_error", valid_values: ["atlassian"] });
  });
});

describe("atlassian config show", () => {
  it("reports missing credentials and a disabled keychain without values", async () => {
    const result = await runCli(["config", "show", "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.keychain).toEqual({ status: "disabled" });
    expect(payload.configured).toBe(false);
    expect(payload.credential_sources.ATLASSIAN_API_TOKEN).toBe("missing");
  });
});
