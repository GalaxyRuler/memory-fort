#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isReleaseQuarantined } from "./release/quarantine.mjs";

const REPOSITORY_ALLOWLIST_PATHS = new Set([
  "AUTHORSHIP.md",
  "LICENSE",
  "LICENSE-NOTICE.md",
  "package.json",
  // Upstream-vendored public bge-small-en-v1.5 files (sha256-pinned in the
  // model manifest); their 30K-wordpiece vocab contains common first names.
  "assets/embedding-models/bge-small-en-v1.5/tokenizer.json",
  "assets/embedding-models/bge-small-en-v1.5/vocab.txt",
]);

const PACKAGE_FULLY_ALLOWLIST_PATHS = new Set([
  // Upstream-vendored public bge-small-en-v1.5 files (sha256-pinned in the
  // model manifest); their 30K-wordpiece vocab contains common first names.
  "assets/embedding-models/bge-small-en-v1.5/tokenizer.json",
  "assets/embedding-models/bge-small-en-v1.5/vocab.txt",
]);

const PACKAGE_ROOT_ATTRIBUTION_PATHS = new Set([
  "AUTHORSHIP.md",
  "LICENSE",
  "LICENSE-NOTICE.md",
  "package.json",
]);

const DENYLIST = [
  deny(literal(["aoa", "@", "live", ".", "ca"].join(""))),
  deny(literal(["a", ".o", ".alku", "laib"].join(""))),
  deny(literal(["srv", "1317946"].join(""))),
  deny(literal(["tail", "6916d8"].join(""))),
  deny(literal(["C:", "\\", "Users", "\\", "Admin"].join(""))),
  deny(literal(["Users", "/", "Admin"].join(""))),
  deny(pathSegments(["C:", ["Codex", "Projects"].join("")])),
  deny(pathSegments(["C:", "Users", "Admin"]), { skipTests: true }),
  exampleDeny(pathSegments(["Users", "Admin"])),
  exampleDeny(literal(["Codex", "Projects"].join(""))),
  exampleDeny(literal(["Claude", "Code", "Projects"].join(""))),
  exampleDeny(literal(["command", "-", "center"].join(""))),
  deny(literal(["One", "Drive"].join(""))),
  deny(literal(["white", "dragon"].join(""))),
  exampleDeny(literal(["WHITE", "DRAGON"].join(""))),
  deny(literal(["vault", "warden"].join(""))),
  deny(word(["iaq", "ar"].join(""))),
  deny(word(["lis", "an"].join(""))),
  deny(word(["veri", "trace"].join(""))),
  deny(word(["apyt", "hon"].join(""))),
  deny(literal(["my", "site", "again"].join(""))),
  deny(word(["Riy", "adh"].join(""))),
  deny(literal(["native", " ", "qt"].join(""))),
  deny(literal(["arabic", " ", "python"].join(""))),
  deny(literal(["personal", " ", "website"].join(""))),
  deny(word(["Abdul", "lah"].join("")), { allowInPackageAttribution: true }),
];

const defaultFileSystem = { access, readdir, readFile, stat };

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const hits = [];

  if (args.packagedRoots.length > 0 || args.packagedOutput) {
    const targets = await resolvePackagedTargets(args);
    for (const target of targets) {
      await scanTarget(target, { quarantine: false, prefix: target.prefix, requireFiles: true }, { hits });
    }
  } else {
    const root = resolve(args.root ?? process.cwd());
    if (args.root) await requireDirectory(root, "scan root");
    await scanTarget({ root, prefix: "" }, { quarantine: true, prefix: "", requireFiles: false }, { hits });
  }

  if (args.json) {
    process.stdout.write(hits.length > 0 ? `${JSON.stringify(hits, null, 2)}\n` : "");
  } else {
    for (const hit of hits) {
      process.stdout.write(`${hit.path}:${hit.line}: denied content\n`);
    }
  }

  process.exitCode = hits.length > 0 ? 1 : 0;
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export async function scanTarget(target, options, { fileSystem = defaultFileSystem, hits = [] } = {}) {
  const files = await listFiles(target.root, { quarantine: options.quarantine, strict: options.requireFiles }, fileSystem);
  if (options.requireFiles && files.length === 0) {
    throw new Error(`package scan root contains no files: ${target.root}`);
  }

  let scanEligibleFiles = 0;
  for (const relPath of files) {
    if (options.quarantine && isQuarantined(relPath)) continue;
    if (shouldSkipFile(relPath, options)) continue;
    scanEligibleFiles += 1;

    let content;
    try {
      content = await fileSystem.readFile(join(target.root, ...relPath.split("/")), "utf8");
    } catch (error) {
      if (options.requireFiles) {
        throw new Error(`package scan could not read ${withPrefix(options.prefix, relPath)}: ${errorMessage(error)}`);
      }
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of DENYLIST) {
        if (rule.exampleOnly && !isMarkdownOrJson(relPath)) continue;
        if (rule.skipTests && isTestPath(relPath)) continue;
        if (isAllowedPackageAttributionMatch(relPath, rule, options)) continue;
        const match = rule.regex.exec(line);
        if (match) {
          hits.push({ path: withPrefix(options.prefix, relPath), line: index + 1 });
        }
      }
    }
  }

  if (options.requireFiles && scanEligibleFiles === 0) {
    throw new Error(`package scan root contains no scan-eligible files: ${target.root}`);
  }

  if (options.quarantine) {
    // Second pass: scan dist/ for the two infra tokens that leaked in 0.1.0.
    // dist/** is quarantined from the main scan (too large/minified), but these
    // specific literals must never appear there.
    const INFRA_TOKENS = [["srv", "1317946"].join(""), ["tail", "6916d8"].join("")];
    const distDir = join(target.root, "dist");
    if (await pathExists(distDir, fileSystem)) {
      const distFiles = await walkDistFiles(distDir, fileSystem);
      for (const fullPath of distFiles) {
        let content;
        try {
          content = await fileSystem.readFile(fullPath, "utf8");
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          for (const token of INFRA_TOKENS) {
            if (line.includes(token)) {
              const rel = toPosixPath(relative(target.root, fullPath));
              hits.push({ path: rel, line: index + 1, scope: "dist" });
            }
          }
        }
      }
    }
  }

  return hits;
}

async function resolvePackagedTargets(options) {
  const targets = [];
  for (const packagedRoot of options.packagedRoots) {
    const root = resolve(packagedRoot);
    await requireDirectory(root, "package scan root");
    targets.push({ root, prefix: "" });
  }
  if (options.packagedOutput) {
    const outputRoot = resolve(options.packagedOutput);
    await requireDirectory(outputRoot, "package scan output");
    targets.push(...await discoverPackagedAppRoots(outputRoot));
  }
  const uniqueTargets = [...new Map(targets.map((target) => [target.root, target])).values()];
  if (uniqueTargets.length === 0) {
    throw new Error("package scan output contains no unpacked app roots");
  }
  return uniqueTargets;
}

async function discoverPackagedAppRoots(outputRoot) {
  const targets = [];
  await walk(outputRoot, "");
  return targets;

  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const relPath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const appRelativePath = entry.name.endsWith(".app")
        ? join(relPath, "Contents", "Resources", "app")
        : entry.name.endsWith("-unpacked")
          ? join(relPath, "resources", "app")
          : null;
      if (appRelativePath) {
        const root = join(outputRoot, appRelativePath);
        if (await isDirectory(root)) {
          targets.push({ root, prefix: toPosixPath(appRelativePath) });
          continue;
        }
      }
      await walk(join(directory, entry.name), relPath);
    }
  }
}

async function requireDirectory(path, label) {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return;
  } catch {
    // The caller receives the same fail-closed error for a missing path.
  }
  throw new Error(`${label} does not exist or is not a directory: ${path}`);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function withPrefix(prefix, relPath) {
  return prefix ? `${prefix}/${relPath}` : relPath;
}

function shouldSkipFile(relPath, options) {
  return options.requireFiles
    ? PACKAGE_FULLY_ALLOWLIST_PATHS.has(relPath)
    : REPOSITORY_ALLOWLIST_PATHS.has(relPath);
}

function isAllowedPackageAttributionMatch(relPath, rule, options) {
  return options.requireFiles
    && PACKAGE_ROOT_ATTRIBUTION_PATHS.has(relPath)
    && rule.allowInPackageAttribution;
}

async function walkDistFiles(dir, fileSystem = defaultFileSystem) {
  const results = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fileSystem.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  await walk(dir);
  return results;
}

function parseArgs(argv) {
  const parsed = { json: false, root: undefined, packagedRoots: [], packagedOutput: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      parsed.root = value;
      index += 1;
      continue;
    }
    if (arg === "--packaged-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--packaged-root requires a path");
      parsed.packagedRoots.push(value);
      index += 1;
      continue;
    }
    if (arg === "--packaged-output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--packaged-output requires a path");
      if (parsed.packagedOutput) throw new Error("--packaged-output may only be provided once");
      parsed.packagedOutput = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (parsed.root && (parsed.packagedRoots.length > 0 || parsed.packagedOutput)) {
    throw new Error("--root cannot be combined with packaged scan options");
  }
  return parsed;
}

async function listFiles(rootPath, options, fileSystem = defaultFileSystem) {
  if (options.quarantine && await pathExists(join(rootPath, ".git"), fileSystem)) {
    try {
      return execFileSync("git", ["-C", rootPath, "ls-files", "-z"], {
        encoding: "utf8",
        windowsHide: true,
      })
        .split("\0")
        .filter(Boolean)
        .map(toPosixPath)
        .sort();
    } catch {
      return walkFiles(rootPath, options, fileSystem);
    }
  }
  return walkFiles(rootPath, options, fileSystem);
}

async function walkFiles(rootPath, options, fileSystem = defaultFileSystem) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fileSystem.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (options.strict) {
        const relDir = toPosixPath(relative(rootPath, dir)) || ".";
        throw new Error(`package scan could not enumerate ${relDir}: ${errorMessage(error)}`);
      }
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = toPosixPath(relative(rootPath, fullPath));
      if (options.quarantine && isQuarantined(relPath)) continue;
      if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
        if (options.strict) {
          throw new Error(`package scan does not support symbolic link: ${relPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        let info;
        try {
          info = await fileSystem.stat(fullPath);
        } catch (error) {
          if (options.strict) throw new Error(`package scan could not inspect ${relPath}: ${errorMessage(error)}`);
          continue;
        }
        if (info.isFile()) files.push(relPath);
      }
    }
  }

  await walk(rootPath);
  return files.sort();
}

async function pathExists(path, fileSystem = defaultFileSystem) {
  try {
    await fileSystem.access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isQuarantined(relPath) {
  return isReleaseQuarantined(relPath);
}

function literal(value) {
  return escapeRegExp(value);
}

function word(value) {
  return `\\b${escapeRegExp(value)}\\b`;
}

function deny(source, options = {}) {
  return {
    regex: new RegExp(source, "i"),
    exampleOnly: Boolean(options.exampleOnly),
    skipTests: Boolean(options.skipTests),
    allowInPackageAttribution: Boolean(options.allowInPackageAttribution),
  };
}

function exampleDeny(source) {
  return deny(source, { exampleOnly: true });
}

function isMarkdownOrJson(relPath) {
  return /\.(?:md|mdx|json|jsonc)$/i.test(relPath);
}

function isTestPath(relPath) {
  return relPath.startsWith("test/");
}

function pathSegments(segments) {
  return segments.map(escapeRegExp).join("[\\\\/]+");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}
