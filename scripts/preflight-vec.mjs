import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const resultDir = path.resolve(
  process.env.PROBE_RESULT_DIR ?? path.join(repoRoot, "docs", "release-evidence"),
);
const isoDate = new Date().toISOString().slice(0, 10);
const resultFile = path.join(
  resultDir,
  `phase0.0-winarm64-${isoDate.replaceAll("-", "")}.md`,
);
const forceSource = process.env.PROBE_FORCE_SOURCE === "1";

const fts5Query =
  "SELECT snippet(t, 0, '<b>', '</b>', '...', 10) AS snippet FROM t WHERE t MATCH 'hello'";
const knnQuery =
  "SELECT rowid FROM v WHERE embedding MATCH '[1.0, 0.1, 0.0]' LIMIT 1";

const probe = {
  date: isoDate,
  runnerLabel: process.env.PROBE_RUNNER_LABEL ?? "windows-11-arm",
  runnerOs: process.env.RUNNER_OS ?? "unknown",
  runnerArch: process.env.RUNNER_ARCH ?? "unknown",
  imageOs: process.env.ImageOS ?? "unknown",
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  fts5: {
    result: "NOT_RUN",
    query: fts5Query,
    returned: null,
    error: null,
  },
  official: {
    attempt: "NOT_RUN",
    path: null,
    provenance: null,
    error: null,
  },
  source: {
    attempt: "NOT_RUN",
    compiler: null,
    source: null,
    releaseTag: null,
    releaseAsset: null,
    headerDir: null,
    output: null,
    provenance: null,
    load: "NOT_RUN",
    error: null,
    buildLogs: [],
  },
  knn: {
    result: "NOT_RUN",
    query: knnQuery,
    expected: 1,
    returned: null,
    error: null,
  },
  loadPath: "FAILED",
  errors: [],
  verdict: "NO-GO",
};

function log(message) {
  console.log(`[preflight-vec] ${message}`);
}

function errorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error.stack) return error.stack;
  if (error.message) return error.message;
  return String(error);
}

function trimLog(value, maxLength = 6000) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  const headLength = Math.min(1200, Math.floor(maxLength / 3));
  const tailLength = maxLength - headLength - 20;
  return `${text.slice(0, headLength)}\n...\n${text.slice(-tailLength)}`;
}

function fence(value) {
  const text = trimLog(value).replaceAll("```", "'''");
  return text ? `\n\`\`\`text\n${text}\n\`\`\`` : "";
}

function commandForDisplay(command, args) {
  return [command, ...args]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    shell: false,
    windowsHide: true,
  });
  return {
    command: commandForDisplay(command, args),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? errorMessage(result.error) : null,
    ok: !result.error && result.status === 0,
  };
}

async function fileProvenance(filePath) {
  const [fileStat, contents] = await Promise.all([stat(filePath), readFile(filePath)]);
  return {
    path: filePath,
    size: fileStat.size,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function findFile(root, predicate) {
  if (!root || !existsSync(root)) return null;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && predicate(entry, fullPath)) return fullPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(path.join(root, entry.name), predicate);
    if (found) return found;
  }
  return null;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "memory-fort-winarm64-sqlite-vec-preflight",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "memory-fort-winarm64-sqlite-vec-preflight",
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, buffer);
}

async function sqliteVecPackageSource(workDir) {
  const packageRoot = path.join(repoRoot, "node_modules", "sqlite-vec");
  const packageSource = await findFile(
    packageRoot,
    (entry) => entry.name === "sqlite-vec.c",
  );
  if (!packageSource) return null;

  const targetDir = path.join(workDir, "package-source");
  await mkdir(targetDir, { recursive: true });
  const targetSource = path.join(targetDir, "sqlite-vec.c");
  await cp(packageSource, targetSource);

  const header = path.join(path.dirname(packageSource), "sqlite-vec.h");
  if (existsSync(header)) {
    await cp(header, path.join(targetDir, "sqlite-vec.h"));
  }

  return {
    file: targetSource,
    source: packageSource,
  };
}

async function downloadLatestAmalgamation(workDir) {
  const releaseUrl = "https://api.github.com/repos/asg017/sqlite-vec/releases/latest";
  const release = await fetchJson(releaseUrl);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset =
    assets.find((candidate) => /amalgamation\.tar\.gz$/i.test(candidate.name)) ??
    assets.find((candidate) => /amalgamation\.zip$/i.test(candidate.name));
  if (!asset?.browser_download_url) {
    throw new Error(`No sqlite-vec amalgamation asset found in ${releaseUrl}`);
  }

  const archivePath = path.join(workDir, asset.name);
  await downloadFile(asset.browser_download_url, archivePath);

  if (/\.tar\.gz$/i.test(asset.name)) {
    const tar = runCommand("tar", ["-xzf", archivePath, "-C", workDir], {
      cwd: workDir,
    });
    if (!tar.ok) {
      throw new Error(
        `Failed to extract ${asset.name}${fence(
          `${tar.command}\nstatus=${tar.status}\n${tar.stdout}\n${tar.stderr}\n${tar.error ?? ""}`,
        )}`,
      );
    }
  } else {
    const expand = runCommand(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        archivePath,
        workDir,
      ],
      { cwd: workDir },
    );
    if (!expand.ok) {
      throw new Error(
        `Failed to extract ${asset.name}${fence(
          `${expand.command}\nstatus=${expand.status}\n${expand.stdout}\n${expand.stderr}\n${expand.error ?? ""}`,
        )}`,
      );
    }
  }

  const sourceFile = await findFile(workDir, (entry) => entry.name === "sqlite-vec.c");
  if (!sourceFile) {
    throw new Error(`Extracted ${asset.name}, but sqlite-vec.c was not found`);
  }

  return {
    file: sourceFile,
    source: asset.browser_download_url,
    releaseTag: release.tag_name ?? "unknown",
    releaseAsset: `${asset.name} (${asset.browser_download_url})`,
  };
}

async function ensureSqliteVecSource(workDir) {
  const packageSource = await sqliteVecPackageSource(workDir);
  if (packageSource) return packageSource;
  return downloadLatestAmalgamation(workDir);
}

async function findSqliteHeaderDir() {
  const candidate = path.join(
    repoRoot,
    "node_modules",
    "better-sqlite3",
    "deps",
    "sqlite3",
  );
  if (
    existsSync(path.join(candidate, "sqlite3.h")) &&
    existsSync(path.join(candidate, "sqlite3ext.h"))
  ) {
    return candidate;
  }

  const packageRoot = path.join(repoRoot, "node_modules", "better-sqlite3");
  const extHeader = await findFile(
    packageRoot,
    (entry) => entry.name === "sqlite3ext.h",
  );
  if (extHeader) {
    const headerDir = path.dirname(extHeader);
    if (existsSync(path.join(headerDir, "sqlite3.h"))) {
      return headerDir;
    }
  }

  throw new Error(
    "Could not find sqlite3.h and sqlite3ext.h under node_modules/better-sqlite3",
  );
}

function msvcArchArg() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "x86";
  return process.arch;
}

function quoteCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function candidateVcvarsallPaths() {
  const paths = [];
  const vcInstallDir = process.env.VCINSTALLDIR;
  if (vcInstallDir) {
    paths.push(path.join(vcInstallDir, "Auxiliary", "Build", "vcvarsall.bat"));
  }

  const editions = ["Enterprise", "Professional", "Community", "BuildTools"];
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  for (const edition of editions) {
    paths.push(
      path.join(
        programFiles,
        "Microsoft Visual Studio",
        "2022",
        edition,
        "VC",
        "Auxiliary",
        "Build",
        "vcvarsall.bat",
      ),
    );
  }

  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    const result = runCommand(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
      "-property",
      "installationPath",
    ]);
    if (result.ok && result.stdout.trim()) {
      paths.push(
        path.join(
          result.stdout.trim().split(/\r?\n/)[0],
          "VC",
          "Auxiliary",
          "Build",
          "vcvarsall.bat",
        ),
      );
    }
  }

  return [...new Set(paths)];
}

function msvcArgs(sourceFile, outputFile, headerDir, workDir) {
  return [
    "/nologo",
    "/LD",
    "/O2",
    "/I",
    headerDir,
    sourceFile,
    `/Fo:${path.join(workDir, "vec0.obj")}`,
    `/Fe:${outputFile}`,
    "/link",
    "/NOLOGO",
    `/IMPLIB:${path.join(workDir, "vec0.lib")}`,
  ];
}

async function compileWithVcvarsall(sourceFile, outputFile, headerDir, workDir) {
  let lastResult = null;
  for (const vcvarsall of candidateVcvarsallPaths()) {
    if (!existsSync(vcvarsall)) continue;
    const cmdFile = path.join(workDir, "build-msvc.cmd");
    const args = msvcArgs(sourceFile, outputFile, headerDir, workDir)
      .map(quoteCmd)
      .join(" ");
    await writeFile(
      cmdFile,
      [
        "@echo off",
        `call ${quoteCmd(vcvarsall)} ${msvcArchArg()}`,
        "if errorlevel 1 exit /b %errorlevel%",
        `cl.exe ${args}`,
        "exit /b %errorlevel%",
        "",
      ].join("\r\n"),
    );
    const result = runCommand("cmd.exe", ["/d", "/s", "/c", cmdFile], {
      cwd: workDir,
    });
    result.command = `call ${vcvarsall} ${msvcArchArg()} && cl.exe ${args}`;
    if (result.ok) return result;
    result.vcvarsall = vcvarsall;
    lastResult = result;
  }

  return lastResult ?? {
    command: "vcvarsall.bat",
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: "vcvarsall.bat was not found",
    ok: false,
  };
}

async function buildSource(db, workDir, sourceInfo) {
  const sourceFile = sourceInfo.file;
  const outputFile = path.join(workDir, "vec0.dll");
  const headerDir = await findSqliteHeaderDir();
  probe.source.headerDir = headerDir;

  const attempts = [
    {
      name: "MSVC cl.exe",
      loadPath: "from-source-msvc",
      run: async () =>
        runCommand("cl.exe", msvcArgs(sourceFile, outputFile, headerDir, workDir), {
          cwd: workDir,
        }),
    },
    {
      name: "MSVC vcvarsall + cl.exe",
      loadPath: "from-source-msvc",
      run: async () => compileWithVcvarsall(sourceFile, outputFile, headerDir, workDir),
    },
    {
      name: "clang-cl",
      loadPath: "from-source-clang",
      run: async () =>
        runCommand(
          "clang-cl",
          [
            "/nologo",
            "/LD",
            "/O2",
            "/I",
            headerDir,
            sourceFile,
            `/Fo:${path.join(workDir, "vec0-clang.obj")}`,
            `/Fe:${outputFile}`,
            "/link",
            "/NOLOGO",
            `/IMPLIB:${path.join(workDir, "vec0-clang.lib")}`,
          ],
          { cwd: workDir },
        ),
    },
    {
      name: "gcc",
      loadPath: "from-source-gcc",
      run: async () =>
        runCommand(
          "gcc",
          ["-shared", "-O2", "-I", headerDir, sourceFile, "-o", outputFile],
          { cwd: workDir },
        ),
    },
  ];

  for (const attempt of attempts) {
    await rm(outputFile, { force: true });
    log(`trying ${attempt.name}`);
    const result = await attempt.run();
    probe.source.buildLogs.push({
      compiler: attempt.name,
      command: result.command,
      status: result.status,
      signal: result.signal,
      stdout: trimLog(result.stdout),
      stderr: trimLog(result.stderr),
      error: result.error,
    });
    if (!result.ok || !existsSync(outputFile)) continue;

    try {
      db.loadExtension(outputFile);
      probe.source.attempt = "SUCCESS";
      probe.source.compiler = attempt.name;
      probe.source.output = outputFile;
      probe.source.provenance = await fileProvenance(outputFile);
      probe.source.load = "SUCCESS";
      probe.loadPath = attempt.loadPath;
      return true;
    } catch (error) {
      probe.source.load = "FAILED";
      probe.source.error = errorMessage(error);
      probe.source.buildLogs.push({
        compiler: `${attempt.name} load`,
        command: `db.loadExtension(${outputFile})`,
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        error: errorMessage(error),
      });
    }
  }

  probe.source.attempt = "FAILED";
  if (!probe.source.error) {
    probe.source.error = "All source build attempts failed";
  }
  return false;
}

function runFts5Probe(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
    db.prepare("INSERT INTO t(body) VALUES (?)").run("say hello world");
    const row = db.prepare(fts5Query).get();
    probe.fts5.returned = row?.snippet ?? null;
    probe.fts5.result =
      typeof row?.snippet === "string" && row.snippet.includes("hello")
        ? "PASS"
        : "FAIL";
  } catch (error) {
    probe.fts5.result = "FAIL";
    probe.fts5.error = errorMessage(error);
  }
}

async function tryOfficialBinary(db) {
  probe.official.attempt = "STARTED";
  try {
    const sqliteVec = await import("sqlite-vec");
    if (typeof sqliteVec.getLoadablePath === "function") {
      try {
        probe.official.path = sqliteVec.getLoadablePath();
      } catch (error) {
        probe.official.error = errorMessage(error);
      }
    }
    if (typeof sqliteVec.load !== "function") {
      throw new Error("sqlite-vec package did not export load(db)");
    }

    sqliteVec.load(db);
    probe.official.attempt = "SUCCESS";
    if (!probe.official.path && typeof sqliteVec.getLoadablePath === "function") {
      probe.official.path = sqliteVec.getLoadablePath();
    }
    if (probe.official.path && existsSync(probe.official.path)) {
      probe.official.provenance = await fileProvenance(probe.official.path);
    }
    probe.loadPath = "official-binary";
    return true;
  } catch (error) {
    probe.official.attempt = "FAILED";
    probe.official.error = [probe.official.error, errorMessage(error)]
      .filter(Boolean)
      .join("\n");
    return false;
  }
}

async function trySourceBuild(db) {
  probe.source.attempt = "STARTED";
  const workDir = await mkdtemp(path.join(tmpdir(), "sqlite-vec-preflight-"));
  try {
    const sourceInfo = await ensureSqliteVecSource(workDir);
    probe.source.source = sourceInfo.source;
    probe.source.releaseTag = sourceInfo.releaseTag ?? null;
    probe.source.releaseAsset = sourceInfo.releaseAsset ?? null;
    return await buildSource(db, workDir, sourceInfo);
  } catch (error) {
    probe.source.attempt = "FAILED";
    probe.source.error = errorMessage(error);
    return false;
  }
}

function runKnnProbe(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[3])");
    const insert = db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, ?)");
    insert.run(1n, "[1.0, 0.0, 0.0]");
    insert.run(2n, "[0.0, 1.0, 0.0]");

    const row = db.prepare(knnQuery).get();
    probe.knn.returned = row?.rowid ?? null;
    probe.knn.result = row?.rowid === probe.knn.expected ? "PASS" : "FAIL";
  } catch (error) {
    probe.knn.result = "FAIL";
    probe.knn.error = errorMessage(error);
  }
}

function provenanceLines(provenance) {
  if (!provenance) return ["Path: n/a", "Size: n/a", "SHA256: n/a"];
  return [
    `Path: ${provenance.path}`,
    `Size: ${provenance.size} bytes`,
    `SHA256: ${provenance.sha256}`,
  ];
}

function buildLogMarkdown() {
  if (probe.source.buildLogs.length === 0) return ["Build attempts: n/a"];
  const lines = ["### Build attempts"];
  for (const attempt of probe.source.buildLogs) {
    lines.push("");
    lines.push(`Compiler: ${attempt.compiler}`);
    lines.push(`Command: ${attempt.command}`);
    lines.push(`Status: ${attempt.status ?? "n/a"}`);
    if (attempt.signal) lines.push(`Signal: ${attempt.signal}`);
    if (attempt.stdout) lines.push(`Stdout:${fence(attempt.stdout)}`);
    if (attempt.stderr) lines.push(`Stderr:${fence(attempt.stderr)}`);
    if (attempt.error) lines.push(`Error:${fence(attempt.error)}`);
  }
  return lines;
}

function evidenceMarkdown() {
  const lines = [
    "# Phase 0.0 -- Win-ARM64 sqlite-vec preflight evidence",
    "",
    `Date: ${probe.date}`,
    `Runner: ${probe.runnerLabel} (GitHub-hosted expected)`,
    `Runner env: ${probe.runnerOs} / ${probe.runnerArch} / ${probe.imageOs}`,
    `Node: ${probe.node}`,
    `Platform: ${probe.platform} / ${probe.arch}`,
    `sqlite-vec load path: ${probe.loadPath}`,
    "",
    "## FTS5 (better-sqlite3)",
    `Result: ${probe.fts5.result}`,
    `Query: ${probe.fts5.query}`,
    `Returned: ${probe.fts5.returned ?? "n/a"}`,
  ];
  if (probe.fts5.error) lines.push(`Error:${fence(probe.fts5.error)}`);

  lines.push(
    "",
    "## sqlite-vec official binary",
    `Attempt: ${probe.official.attempt}`,
    ...provenanceLines(probe.official.provenance),
  );
  if (probe.official.path && !probe.official.provenance) {
    lines.push(`Resolved path: ${probe.official.path}`);
  }
  if (probe.official.error) lines.push(`Error:${fence(probe.official.error)}`);

  lines.push(
    "",
    "## sqlite-vec from-source",
    `Attempt: ${probe.source.attempt}`,
    `Compiler: ${probe.source.compiler ?? "n/a"}`,
    `Source: ${probe.source.source ?? "n/a"}`,
    `Release tag: ${probe.source.releaseTag ?? "n/a"}`,
    `Release asset: ${probe.source.releaseAsset ?? "n/a"}`,
    `SQLite header dir: ${probe.source.headerDir ?? "n/a"}`,
    `Load: ${probe.source.load}`,
    ...provenanceLines(probe.source.provenance),
  );
  if (probe.source.error) lines.push(`Error:${fence(probe.source.error)}`);
  lines.push(...buildLogMarkdown());

  lines.push(
    "",
    "## KNN assertion",
    `Query: ${probe.knn.query}`,
    `Expected rowid: ${probe.knn.expected}`,
    `Returned rowid: ${probe.knn.returned ?? "n/a"}`,
    `Result: ${probe.knn.result}`,
  );
  if (probe.knn.error) lines.push(`Error:${fence(probe.knn.error)}`);

  if (probe.errors.length > 0) {
    lines.push("", "## Probe errors");
    for (const error of probe.errors) lines.push(`- ${error}`);
  }

  lines.push("", `## Verdict: ${probe.verdict}`, "");
  return lines.join("\n");
}

async function writeEvidence() {
  await mkdir(resultDir, { recursive: true });
  await writeFile(resultFile, evidenceMarkdown(), "utf8");
  log(`wrote evidence to ${resultFile}`);
}

async function main() {
  let db = null;
  try {
    log(`platform=${probe.platform} arch=${probe.arch} node=${probe.node}`);

    let Database;
    try {
      ({ default: Database } = await import("better-sqlite3"));
    } catch (error) {
      probe.fts5.result = "FAIL";
      probe.fts5.error = `Could not import better-sqlite3: ${errorMessage(error)}`;
      probe.knn.result = "FAIL";
      probe.knn.error =
        "better-sqlite3 was not available, so sqlite-vec could not be loaded";
      probe.errors.push("better-sqlite3 import failed");
      return;
    }

    db = new Database(":memory:");
    runFts5Probe(db);

    let officialLoaded = false;
    if (forceSource) {
      probe.official.attempt = "SKIPPED";
      probe.official.error = "Skipped because PROBE_FORCE_SOURCE=1";
    } else {
      officialLoaded = await tryOfficialBinary(db);
    }
    const vecLoaded = officialLoaded || (await trySourceBuild(db));
    if (vecLoaded) {
      runKnnProbe(db);
    } else {
      probe.knn.result = "FAIL";
      probe.knn.error = "sqlite-vec did not load through the official or source path";
    }
  } catch (error) {
    probe.errors.push(errorMessage(error));
  } finally {
    if (db) db.close();
    probe.verdict =
      probe.fts5.result === "PASS" && probe.knn.result === "PASS" ? "GO" : "NO-GO";
    await writeEvidence();
    process.exitCode = probe.verdict === "GO" ? 0 : 1;
  }
}

await main();
