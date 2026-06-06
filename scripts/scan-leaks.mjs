#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { QUARANTINE_GLOBS } from "./release/quarantine.mjs";

const ALLOWLIST_PATHS = new Set([
  "AUTHORSHIP.md",
  "LICENSE",
  "LICENSE-NOTICE.md",
  "package.json",
]);

const DENYLIST = [
  literal(["aoa", "@", "live", ".", "ca"].join("")),
  literal(["a", ".o", ".alku", "laib"].join("")),
  literal(["srv", "1317946"].join("")),
  literal(["tail", "6916d8"].join("")),
  literal(["C:", "\\", "Users", "\\", "Admin"].join("")),
  literal(["Users", "/", "Admin"].join("")),
  literal(["C:", "\\", "Codex", "Projects"].join("")),
  literal(["C:", "\\", "\\", "Codex", "Projects"].join("")),
  literal(["C:", "/", "Codex", "Projects"].join("")),
  literal(["One", "Drive"].join("")),
  literal(["white", "dragon"].join("")),
  literal(["vault", "warden"].join("")),
  word(["iaq", "ar"].join("")),
  word(["lis", "an"].join("")),
  word(["veri", "trace"].join("")),
  word(["apyt", "hon"].join("")),
  literal(["my", "site", "again"].join("")),
  word(["Riy", "adh"].join("")),
  literal(["native", " ", "qt"].join("")),
  literal(["arabic", " ", "python"].join("")),
  literal(["personal", " ", "website"].join("")),
  word(["Abdul", "lah"].join("")),
].map((source) => new RegExp(source, "i"));

const quarantineMatchers = QUARANTINE_GLOBS.map(globToRegExp);

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? process.cwd());
const files = await listFiles(root);
const hits = [];

for (const relPath of files) {
  if (isQuarantined(relPath)) continue;
  if (ALLOWLIST_PATHS.has(relPath)) continue;

  let content;
  try {
    content = await readFile(join(root, ...relPath.split("/")), "utf8");
  } catch {
    continue;
  }

  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const pattern of DENYLIST) {
      const match = pattern.exec(line);
      if (match) {
        hits.push({ path: relPath, line: index + 1, token: match[0] });
      }
    }
  }
}

if (args.json) {
  process.stdout.write(hits.length > 0 ? `${JSON.stringify(hits, null, 2)}\n` : "");
} else {
  for (const hit of hits) {
    process.stdout.write(`${hit.path}:${hit.line}: ${hit.token}\n`);
  }
}

process.exitCode = hits.length > 0 ? 1 : 0;

// Second pass: scan dist/ for the two infra tokens that leaked in 0.1.0.
// dist/** is quarantined from the main scan (too large/minified), but these
// specific literals must never appear there.
const INFRA_TOKENS = [["srv", "1317946"].join(""), ["tail", "6916d8"].join("")];
const distDir = join(root, "dist");
if (await pathExists(distDir)) {
  const distFiles = await walkDistFiles(distDir);
  for (const fullPath of distFiles) {
    let content;
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const token of INFRA_TOKENS) {
        if (line.includes(token)) {
          const rel = toPosixPath(relative(root, fullPath));
          process.stderr.write(`dist/ contains private infra token\n${rel}:${index + 1}: ${token}\n`);
          process.exit(1);
        }
      }
    }
  }
}

async function walkDistFiles(dir) {
  const results = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
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
  const parsed = { json: false, root: undefined };
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
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

async function listFiles(rootPath) {
  if (await pathExists(join(rootPath, ".git"))) {
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
      return walkFiles(rootPath);
    }
  }
  return walkFiles(rootPath);
}

async function walkFiles(rootPath) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = toPosixPath(relative(rootPath, fullPath));
      if (isQuarantined(relPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const info = await stat(fullPath);
        if (info.isFile()) files.push(relPath);
      }
    }
  }

  await walk(rootPath);
  return files.sort();
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isQuarantined(relPath) {
  const normalized = toPosixPath(relPath);
  return quarantineMatchers.some((matcher) => matcher.test(normalized));
}

function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source, "i");
}

function literal(value) {
  return escapeRegExp(value);
}

function word(value) {
  return `\\b${escapeRegExp(value)}\\b`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}
