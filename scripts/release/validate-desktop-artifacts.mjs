#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const PLATFORM_POLICY = {
  Windows: { installerSuffix: ".exe", updater: "latest.yml" },
  macOS: { installerSuffix: ".dmg", updater: "latest-mac.yml" },
  Linux: { installerSuffix: ".AppImage", updater: "latest-linux.yml" },
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key ?? "<end>"}`);
    args[key.slice(2)] = value;
  }
  return args;
}

function findManifests(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findManifests(path));
    else if (/^artifact-manifest-(Windows|macOS|Linux)\.json$/.test(entry.name)) found.push(path);
  }
  return found;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.tag) throw new Error("--root and --tag are required");
  const manifests = findManifests(resolve(args.root));
  if (manifests.length !== 3) throw new Error(`expected 3 platform manifests, found ${manifests.length}`);

  const seenPlatforms = new Set();
  let expectedVersion;
  let expectedCommit;
  for (const manifestPath of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (error) {
      throw new Error(`invalid manifest ${manifestPath}: ${error.message}`);
    }
    const policy = PLATFORM_POLICY[manifest.platform];
    if (manifest.schemaVersion !== 1 || !policy) throw new Error(`invalid manifest schema or platform: ${manifestPath}`);
    if (seenPlatforms.has(manifest.platform)) throw new Error(`duplicate platform manifest: ${manifest.platform}`);
    seenPlatforms.add(manifest.platform);
    if (manifest.tag !== args.tag) throw new Error(`manifest tag mismatch for ${manifest.platform}`);
    if (manifest.tag !== `v${manifest.version}`) throw new Error(`tag/version mismatch for ${manifest.platform}`);
    expectedVersion ??= manifest.version;
    expectedCommit ??= manifest.commit;
    if (manifest.version !== expectedVersion) throw new Error("platform manifests have different versions");
    if (manifest.commit !== expectedCommit) throw new Error("platform manifests have different commits");
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error(`manifest has no files: ${manifest.platform}`);
    }

    const names = new Set(manifest.files.map((file) => file.name));
    if (![...names].some((name) => name.endsWith(policy.installerSuffix))) {
      throw new Error(`missing ${policy.installerSuffix} installer in ${manifest.platform} manifest`);
    }
    if (!names.has(policy.updater)) throw new Error(`missing ${policy.updater} in ${manifest.platform} manifest`);

    const directory = dirname(manifestPath);
    for (const file of manifest.files) {
      if (typeof file.name !== "string" || basename(file.name) !== file.name) {
        throw new Error(`unsafe artifact name in ${manifest.platform} manifest`);
      }
      const path = join(directory, file.name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        throw new Error(`missing artifact: ${manifest.platform}/${file.name}`);
      }
      if (!stats.isFile() || stats.size !== file.size) {
        throw new Error(`size mismatch: ${manifest.platform}/${file.name}`);
      }
      if (await sha256(path) !== file.sha256) {
        throw new Error(`hash mismatch: ${manifest.platform}/${file.name}`);
      }
    }
  }
  for (const platform of Object.keys(PLATFORM_POLICY)) {
    if (!seenPlatforms.has(platform)) throw new Error(`missing platform manifest: ${platform}`);
  }
  process.stdout.write(`desktop artifact set passed: ${args.tag} ${expectedCommit}\n`);
}

main().catch((error) => {
  process.stderr.write(`validate-desktop-artifacts: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
