#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function releaseFiles(directory, policy) {
  const names = readdirSync(directory).filter((name) => statSync(join(directory, name)).isFile());
  const installers = names.filter((name) => name.endsWith(policy.installerSuffix));
  if (installers.length === 0) throw new Error(`missing ${policy.installerSuffix} installer`);
  for (const installer of installers) {
    if (!names.includes(`${installer}.zip`)) throw new Error(`missing zipped installer: ${installer}.zip`);
  }
  if (!names.includes(policy.updater)) throw new Error(`missing updater metadata: ${policy.updater}`);

  const selected = new Set([policy.updater]);
  for (const installer of installers) {
    selected.add(installer);
    selected.add(`${installer}.zip`);
  }
  for (const name of names) {
    if (name.endsWith(".blockmap")) selected.add(name);
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const directory = resolve(args.directory ?? "");
  const policy = PLATFORM_POLICY[args.platform];
  if (!args.directory) throw new Error("--directory is required");
  if (!policy) throw new Error("--platform must be Windows, macOS, or Linux");
  if (!args.tag || !args.version || !args.commit) throw new Error("--tag, --version, and --commit are required");
  if (args.tag !== `v${args.version}`) {
    throw new Error(`release tag ${args.tag} does not match package version ${args.version}`);
  }

  const names = releaseFiles(directory, policy);
  const files = [];
  for (const name of names) {
    if (basename(name) !== name) throw new Error(`unsafe artifact name: ${name}`);
    const path = join(directory, name);
    files.push({ name, size: statSync(path).size, sha256: await sha256(path) });
  }
  const manifest = {
    schemaVersion: 1,
    platform: args.platform,
    tag: args.tag,
    version: args.version,
    commit: args.commit,
    createdAt: new Date().toISOString(),
    files,
  };
  const output = join(directory, `artifact-manifest-${args.platform}.json`);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`create-desktop-artifact-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
