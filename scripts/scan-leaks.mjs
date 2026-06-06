#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { isReleaseQuarantined } from "./release/quarantine.mjs";

const ALLOWLIST_PATHS = new Set([
  "AUTHORSHIP.md",
  "COMMERCIAL.md",
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
  deny(word(["Abdul", "lah"].join(""))),
];

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
    for (const rule of DENYLIST) {
      if (rule.exampleOnly && !isMarkdownOrJson(relPath)) continue;
      if (rule.skipTests && isTestPath(relPath)) continue;
      const match = rule.regex.exec(line);
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

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}
