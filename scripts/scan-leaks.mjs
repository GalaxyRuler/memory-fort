#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isReleaseQuarantined } from "./release/quarantine.mjs";

const FULLY_ALLOWLIST_PATHS = new Set([
  // Upstream-vendored public bge-small-en-v1.5 files (sha256-pinned in the
  // model manifest); their 30K-wordpiece vocab contains common first names.
  "assets/embedding-models/bge-small-en-v1.5/tokenizer.json",
  "assets/embedding-models/bge-small-en-v1.5/vocab.txt",
]);

const ATTRIBUTION_PATHS = new Set([
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
  deny(word(["Abdul", "lah"].join("")), { allowInAttribution: true }),
];

const defaultFileSystem = { access, open, readdir, readFile, stat };
const REPOSITORY_DIST_CHUNK_BYTES = 64 * 1024;
const LF_BYTE = 0x0a;

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
      process.stdout.write(`${hit.path}:${hit.line}: denied ${hit.kind ?? "content"}\n`);
    }
  }

  process.exitCode = hits.length > 0 ? 1 : 0;
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export async function scanTarget(target, options, { fileSystem = defaultFileSystem, hits = [] } = {}) {
  const inventory = await listFiles(
    target.root,
    { quarantine: options.quarantine, scope: options.requireFiles ? "package" : "repository" },
    fileSystem,
  );
  const { files, paths } = inventory;
  if (options.requireFiles && files.length === 0) {
    throw new Error(`package scan root contains no files: ${redact(target.root)}`);
  }

  for (const relPath of paths) {
    if (options.quarantine && isQuarantined(relPath)) continue;
    scanPath(relPath, options, hits);
  }

  let scanEligibleFiles = 0;
  for (const relPath of files) {
    if (options.quarantine && isQuarantined(relPath)) continue;
    if (shouldSkipFile(relPath)) continue;
    scanEligibleFiles += 1;

    let content;
    try {
      content = await fileSystem.readFile(join(target.root, ...relPath.split("/")), "utf8");
    } catch (error) {
      const scope = options.requireFiles ? "package" : "repository";
      throw new Error(`${scope} scan could not read ${withPrefix(options.prefix, relPath)}: ${errorMessage(error)}`);
    }

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of DENYLIST) {
        if (!shouldApplyRule(rule, relPath)) continue;
        const match = rule.regex.exec(line);
        if (match) {
          hits.push({ path: withPrefix(options.prefix, relPath), line: index + 1 });
        }
      }
    }
  }

  if (options.requireFiles && scanEligibleFiles === 0) {
    throw new Error(`package scan root contains no scan-eligible files: ${redact(target.root)}`);
  }

  if (options.quarantine) {
    // Second pass: scan dist/ for the two infra tokens that leaked in 0.1.0.
    // dist/** is quarantined from the main scan (too large/minified), but these
    // specific literals must never appear there.
    const INFRA_TOKENS = [["srv", "1317946"].join(""), ["tail", "6916d8"].join("")];
    const distDir = join(target.root, "dist");
    if (await pathExists(distDir, fileSystem)) {
      const distFiles = await walkDistFiles(distDir, fileSystem);
      const markerBuffers = INFRA_TOKENS.map((token) => Buffer.from(token, "utf8"));
      for (const fullPath of distFiles) {
        await scanRepositoryDistFile(
          fullPath,
          {
            distDir,
            root: target.root,
            markerBuffers,
          },
          fileSystem,
          hits,
        );
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
    const discoveredTargets = [...new Map(
      (await discoverPackagedAppRoots(outputRoot)).map((target) => [target.root, target]),
    ).values()];
    if (options.expectedRoots !== undefined && discoveredTargets.length !== options.expectedRoots) {
      throw new Error(
        `package scan output expected ${options.expectedRoots} unpacked app roots, found ${discoveredTargets.length}`,
      );
    }
    targets.push(...discoveredTargets);
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
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const relPath = toPosixPath(relative(outputRoot, directory)) || ".";
      throw new Error(`package scan could not enumerate ${redact(relPath)}: ${errorMessage(error)}`);
    }
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
  throw new Error(`${label} does not exist or is not a directory: ${redact(path)}`);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function withPrefix(prefix, relPath) {
  return redact(prefix ? `${prefix}/${relPath}` : relPath);
}

function shouldSkipFile(relPath) {
  return FULLY_ALLOWLIST_PATHS.has(relPath);
}

function isAllowedAttributionMatch(relPath, rule, { path }) {
  return !path
    && ATTRIBUTION_PATHS.has(relPath)
    && rule.allowInAttribution;
}

function shouldApplyRule(rule, relPath, { path = false } = {}) {
  if (!path && rule.exampleOnly && !isMarkdownOrJson(relPath)) return false;
  if (rule.skipTests && isTestPath(relPath)) return false;
  if (isAllowedAttributionMatch(relPath, rule, { path })) return false;
  return true;
}

function scanPath(relPath, options, hits) {
  for (const rule of DENYLIST) {
    if (!shouldApplyRule(rule, relPath, { path: true })) continue;
    if (rule.regex.test(relPath)) {
      hits.push({ path: withPrefix(options.prefix, relPath), line: 0, kind: "path" });
    }
  }
}

async function walkDistFiles(dir, fileSystem = defaultFileSystem) {
  const results = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fileSystem.readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`repository scan could not enumerate ${redact(distRelativePath(dir, current))}: ${errorMessage(error)}`);
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      const relPath = distRelativePath(dir, fullPath);
      if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
        throw new Error(`repository scan does not support symbolic link: ${redact(relPath)}`);
      }
      const isDirectoryEntry = entry.isDirectory();
      const isFileEntry = entry.isFile();
      if (!isDirectoryEntry && !isFileEntry) {
        throw new Error(`repository scan encountered unsupported entry: ${redact(relPath)}`);
      }
      if (isDirectoryEntry) {
        let info;
        try {
          info = await fileSystem.stat(fullPath);
        } catch (error) {
          throw new Error(`repository scan could not inspect ${redact(relPath)}: ${errorMessage(error)}`);
        }
        if (!info.isDirectory()) {
          throw new Error(`repository scan entry type mismatch: ${redact(relPath)}`);
        }
        await walk(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }
  await walk(dir);
  return results;
}

async function scanRepositoryDistFile(fullPath, options, fileSystem, hits) {
  const distPath = distRelativePath(options.distDir, fullPath);
  const resultPath = redact(toPosixPath(relative(options.root, fullPath)));
  let handle;
  try {
    handle = await fileSystem.open(fullPath, "r");
  } catch (error) {
    throw new Error(`repository scan could not open ${redact(distPath)}: ${errorMessage(error)}`);
  }

  let scanFailure;
  let closeFailure;
  try {
    const initialInfo = await inspectOpenedRepositoryDistFile(handle, distPath);
    const initialSize = validateOpenedRepositoryDistFile(initialInfo, distPath);
    await scanOpenedRepositoryDistFile(
      handle,
      {
        initialSize,
        markerBuffers: options.markerBuffers,
        resultPath,
        distPath,
      },
      hits,
    );
    const finalInfo = await inspectOpenedRepositoryDistFile(handle, distPath);
    const finalSize = validateOpenedRepositoryDistFile(finalInfo, distPath);
    if (finalSize !== initialSize) {
      throw new Error(`repository scan file changed size while reading ${redact(distPath)}`);
    }
  } catch (error) {
    scanFailure = new Error(errorMessage(error));
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeFailure = new Error(
        `repository scan could not close ${redact(distPath)}: ${errorMessage(error)}`,
      );
    }
  }

  if (scanFailure && closeFailure) {
    throw new Error(`${scanFailure.message}; ${closeFailure.message}`);
  }
  if (scanFailure) throw scanFailure;
  if (closeFailure) throw closeFailure;
}

async function inspectOpenedRepositoryDistFile(handle, distPath) {
  try {
    return await handle.stat();
  } catch (error) {
    throw new Error(
      `repository scan could not inspect ${redact(distPath)}: ${errorMessage(error)}`,
    );
  }
}

function validateOpenedRepositoryDistFile(info, distPath) {
  if (!info || typeof info.isFile !== "function" || !info.isFile()) {
    throw new Error(`repository scan opened path is not a regular file: ${redact(distPath)}`);
  }
  if (!Number.isSafeInteger(info.size) || info.size < 0) {
    throw new Error(`repository scan opened file has invalid file size: ${redact(distPath)}`);
  }
  return info.size;
}

async function scanOpenedRepositoryDistFile(handle, options, hits) {
  const chunk = Buffer.allocUnsafe(REPOSITORY_DIST_CHUNK_BYTES);
  const growthProbe = Buffer.allocUnsafe(1);
  const overlapBytes = Math.max(...options.markerBuffers.map((marker) => marker.length)) - 1;
  const lastReportedLine = options.markerBuffers.map(() => 0);
  let tail = Buffer.alloc(0);
  let position = 0;
  let lineAtFreshStart = 1;

  while (position < options.initialSize) {
    const length = Math.min(REPOSITORY_DIST_CHUNK_BYTES, options.initialSize - position);
    const bytesRead = await readOpenedRepositoryDistFile(
      handle,
      chunk,
      length,
      position,
      options.distPath,
    );
    if (bytesRead === 0) {
      throw new Error(
        `repository scan file changed size while reading ${redact(options.distPath)}`,
      );
    }

    const fresh = chunk.subarray(0, bytesRead);
    const combined = tail.length > 0 ? Buffer.concat([tail, fresh]) : fresh;
    const lineAtCombinedStart = lineAtFreshStart - countLfBytes(tail);
    scanRepositoryDistChunk(
      combined,
      lineAtCombinedStart,
      options.markerBuffers,
      lastReportedLine,
      options.resultPath,
      hits,
    );
    lineAtFreshStart += countLfBytes(fresh);
    position += bytesRead;
    tail = overlapBytes > 0
      ? Buffer.from(combined.subarray(Math.max(0, combined.length - overlapBytes)))
      : Buffer.alloc(0);
  }

  const growthBytes = await readOpenedRepositoryDistFile(
    handle,
    growthProbe,
    growthProbe.length,
    options.initialSize,
    options.distPath,
  );
  if (growthBytes !== 0) {
    throw new Error(
      `repository scan file changed size while reading ${redact(options.distPath)}`,
    );
  }
}

async function readOpenedRepositoryDistFile(handle, buffer, length, position, distPath) {
  let result;
  try {
    result = await handle.read(buffer, 0, length, position);
  } catch (error) {
    throw new Error(`repository scan could not read ${redact(distPath)}: ${errorMessage(error)}`);
  }
  if (
    !result
    || !Number.isSafeInteger(result.bytesRead)
    || result.bytesRead < 0
    || result.bytesRead > length
  ) {
    throw new Error(`repository scan received invalid read result for ${redact(distPath)}`);
  }
  return result.bytesRead;
}

function scanRepositoryDistChunk(
  content,
  startingLine,
  markerBuffers,
  lastReportedLine,
  resultPath,
  hits,
) {
  const matches = [];
  for (const [markerIndex, marker] of markerBuffers.entries()) {
    let offset = content.indexOf(marker);
    while (offset !== -1) {
      matches.push({ markerIndex, offset });
      offset = content.indexOf(marker, offset + 1);
    }
  }
  matches.sort((left, right) => (
    left.offset - right.offset || left.markerIndex - right.markerIndex
  ));

  let line = startingLine;
  let lineCursor = 0;
  for (const match of matches) {
    line += countLfBytes(content, lineCursor, match.offset);
    lineCursor = match.offset;
    if (line <= lastReportedLine[match.markerIndex]) continue;
    lastReportedLine[match.markerIndex] = line;
    hits.push({ path: resultPath, line, scope: "dist" });
  }
}

function countLfBytes(content, start = 0, end = content.length) {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (content[index] === LF_BYTE) count += 1;
  }
  return count;
}

function distRelativePath(distDir, path) {
  const relPath = toPosixPath(relative(distDir, path));
  return relPath ? `dist/${relPath}` : "dist";
}

function parseArgs(argv) {
  const parsed = { json: false, root: undefined, packagedRoots: [], packagedOutput: undefined, expectedRoots: undefined };
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
    if (arg === "--expect-roots") {
      const value = argv[index + 1];
      if (!value) throw new Error("--expect-roots requires a positive integer");
      if (parsed.expectedRoots !== undefined) throw new Error("--expect-roots may only be provided once");
      const expectedRoots = Number(value);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(expectedRoots)) {
        throw new Error("--expect-roots must be a positive integer");
      }
      parsed.expectedRoots = expectedRoots;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${redact(arg)}`);
  }
  if (parsed.root && (parsed.packagedRoots.length > 0 || parsed.packagedOutput)) {
    throw new Error("--root cannot be combined with packaged scan options");
  }
  if (parsed.expectedRoots !== undefined && !parsed.packagedOutput) {
    throw new Error("--expect-roots requires --packaged-output");
  }
  return parsed;
}

async function listFiles(rootPath, options, fileSystem = defaultFileSystem) {
  if (options.quarantine && await pathExists(join(rootPath, ".git"), fileSystem)) {
    try {
      const files = execFileSync("git", ["-C", rootPath, "ls-files", "-z"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
        .split("\0")
        .filter(Boolean)
        .map(toPosixPath)
        .sort();
      return { files, paths: pathsFromFiles(files) };
    } catch (error) {
      throw new Error(`repository scan could not enumerate Git inventory: ${errorMessage(error)}`);
    }
  }
  return walkFiles(rootPath, options, fileSystem);
}

async function walkFiles(rootPath, options, fileSystem = defaultFileSystem) {
  const files = [];
  const paths = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fileSystem.readdir(dir, { withFileTypes: true });
    } catch (error) {
      const relDir = toPosixPath(relative(rootPath, dir)) || ".";
      throw new Error(`${options.scope} scan could not enumerate ${redact(relDir)}: ${errorMessage(error)}`);
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = toPosixPath(relative(rootPath, fullPath));
      if (options.quarantine && isQuarantined(relPath)) continue;
      if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
        throw new Error(`${options.scope} scan does not support symbolic link: ${redact(relPath)}`);
      }
      const isDirectoryEntry = entry.isDirectory();
      const isFileEntry = entry.isFile();
      if (!isDirectoryEntry && !isFileEntry) {
        throw new Error(`${options.scope} scan encountered unsupported entry: ${redact(relPath)}`);
      }
      let info;
      try {
        info = await fileSystem.stat(fullPath);
      } catch (error) {
        throw new Error(`${options.scope} scan could not inspect ${redact(relPath)}: ${errorMessage(error)}`);
      }
      if ((isDirectoryEntry && !info.isDirectory()) || (isFileEntry && !info.isFile())) {
        throw new Error(`${options.scope} scan entry type mismatch: ${redact(relPath)}`);
      }
      paths.push(relPath);
      if (isDirectoryEntry) {
        await walk(fullPath);
      } else {
        files.push(relPath);
      }
    }
  }

  await walk(rootPath);
  return {
    files: files.sort(),
    paths: [...new Set(paths)].sort(),
  };
}

function pathsFromFiles(files) {
  const paths = new Set();
  for (const file of files) {
    const segments = file.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      paths.add(segments.slice(0, index).join("/"));
    }
  }
  return [...paths].sort();
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
    allowInAttribution: Boolean(options.allowInAttribution),
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
  return redact(error instanceof Error ? error.message : String(error));
}

function redact(value) {
  let result = String(value);
  for (const rule of DENYLIST) {
    result = result.replace(new RegExp(rule.regex.source, "gi"), "[REDACTED]");
  }
  return result;
}

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}
