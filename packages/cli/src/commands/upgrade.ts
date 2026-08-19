import { buildCommand } from "@stricli/core";
import { createHash } from "node:crypto";
import { chmod, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CLI_VERSION } from "../version.js";

const REPO = "spenserhale/atlassian-ai-toolkit";
const INSTALL_HINT = "curl -fsSL https://raw.githubusercontent.com/spenserhale/atlassian-ai-toolkit/main/scripts/install.sh | sh";

interface UpgradeFlags {
  readonly "dry-run": boolean;
  readonly json: boolean;
}

interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface Release {
  readonly tag_name: string;
  readonly html_url: string;
  readonly assets: readonly ReleaseAsset[];
}

function assetName(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (os === undefined || arch === undefined) {
    throw new Error(`No release binary for ${process.platform}-${process.arch}; see https://github.com/${REPO}/releases`);
  }
  return `atlassian-${os}-${arch}${process.platform === "win32" ? ".exe" : ""}`;
}

function compareVersions(a: string, b: string): number {
  const parse = (version: string): number[] => version.replace(/^v/, "").split(".").map(Number);
  const [av, bv] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const delta = (av[i] ?? 0) - (bv[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function requireAsset(release: Release, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (asset === undefined) throw new Error(`Release ${release.tag_name} has no ${name} asset; see ${release.html_url}`);
  return asset;
}

export const upgradeCommand = buildCommand({
  docs: {
    brief: "Upgrade the atlassian CLI to the latest release",
  },
  parameters: {
    flags: {
      "dry-run": { kind: "boolean", brief: "Show available upgrade without applying it", default: false },
      json: { kind: "boolean", brief: "Output as JSON", default: false },
    },
  },
  async func(this: void, flags: UpgradeFlags) {
    try {
      const releaseRes = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!releaseRes.ok) throw new Error(`GitHub release lookup failed (HTTP ${releaseRes.status})`);
      const release = (await releaseRes.json()) as Release;
      const latest = release.tag_name.replace(/^v/, "");
      const current = CLI_VERSION;
      const updateAvailable = compareVersions(latest, current) > 0;

      const print = (payload: unknown, text: string): void => console.log(flags.json ? JSON.stringify(payload, null, 2) : text);
      if (flags["dry-run"] || !updateAvailable) {
        const status = updateAvailable ? "would_upgrade" : "up_to_date";
        print(
          { status, current: `v${current}`, latest: `v${latest}` },
          `status: ${status}\ncurrent: v${current}\nlatest: v${latest}`
        );
        return;
      }

      const asset = assetName();
      const binary = await download(requireAsset(release, asset).browser_download_url);
      const expected = (await download(requireAsset(release, `${asset}.sha256`).browser_download_url))
        .toString("utf8")
        .trim()
        .split(/\s+/)[0];
      const actual = createHash("sha256").update(binary).digest("hex");
      if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}; refusing to upgrade`);

      const execPath = process.execPath;
      if (basename(execPath).replace(/\.exe$/, "") === "bun" || basename(execPath) === "bun-debug") {
        throw new Error(`Running under Bun, not an installed binary; reinstall the latest release with: ${INSTALL_HINT}`);
      }

      const tempPath = join(dirname(execPath), `.${basename(execPath)}.${process.pid}.tmp`);
      await writeFile(tempPath, binary);
      await chmod(tempPath, 0o755);
      try {
        await rename(tempPath, execPath);
      } catch (err) {
        throw new Error(
          `Could not replace ${execPath} (${err instanceof Error ? err.message : err}). Close running instances and retry, or reinstall with: ${INSTALL_HINT}`
        );
      }

      print(
        { status: "upgraded", previous: `v${current}`, current: `v${latest}`, path: execPath },
        `status: upgraded\nprevious: v${current}\ncurrent: v${latest}\npath: ${execPath}`
      );
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  },
});
