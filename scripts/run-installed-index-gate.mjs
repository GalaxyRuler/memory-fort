import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  defaultHugeBytes,
  defaultSmallFiles,
  defaultTargetBytes,
  formatBytes,
  generateSyntheticVault,
  inspectSyntheticVault,
  MiB,
} from "./synthetic-vault.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const { values } = parseArgs({
  options: {
    "app-executable": { type: "string" },
    "app-arg": { type: "string", multiple: true, default: [] },
    "work-dir": { type: "string" },
    "target-mib": { type: "string", default: "750" },
    "huge-mib": { type: "string", default: "150" },
    "small-files": { type: "string", default: String(defaultSmallFiles) },
    "query": { type: "string", default: "needle" },
    "evidence-json": { type: "string" },
    "evidence-path": { type: "string" },
    "log-dir": { type: "string" },
    "reuse-vault": { type: "boolean", default: false },
    "timeout-minutes": { type: "string", default: "25" },
    "xvfb": { type: "boolean", default: false },
  },
});

const appExecutable = requiredString(values["app-executable"], "--app-executable");
const targetBytes = Number(values["target-mib"]) * MiB;
const hugeBytes = Number(values["huge-mib"]) * MiB;
const smallFiles = Number.parseInt(values["small-files"], 10);
const timeoutMinutes = Number.parseInt(values["timeout-minutes"], 10);
const query = String(values.query ?? "needle");
const workDir = path.resolve(
  values["work-dir"] ?? path.join(tmpdir(), `memory-fort-phase3-installed-gate-${defaultDate}`),
);
const vaultRoot = path.join(workDir, "synthetic-vault");
const dbRoot = path.join(workDir, "index-db");
const indexDbPath = path.join(dbRoot, "index.db");
const resultJson = path.resolve(
  values["evidence-json"] ?? path.join(workDir, "installed-index-gate-result.json"),
);
const evidencePath = path.resolve(
  values["evidence-path"] ??
    path.join(repoRoot, "docs", "release-evidence", `phase3-installed-index-gate-${defaultDate}.md`),
);
const logDir = path.resolve(values["log-dir"] ?? path.join(workDir, "logs"));
const sentinelPath = path.join(workDir, "legacy-loadSearchCorpus.invocations.jsonl");
const stdoutPath = path.join(logDir, "installed-index-gate.stdout.log");
const stderrPath = path.join(logDir, "installed-index-gate.stderr.log");
const appArgs = Array.isArray(values["app-arg"]) ? values["app-arg"].map(String) : [];

if (!Number.isFinite(targetBytes) || targetBytes <= 0) throw new Error("--target-mib must be positive");
if (!Number.isFinite(hugeBytes) || hugeBytes <= 0) throw new Error("--huge-mib must be positive");
if (hugeBytes >= targetBytes) throw new Error("--huge-mib must be smaller than --target-mib");
if (!Number.isInteger(smallFiles) || smallFiles <= 0) throw new Error("--small-files must be positive");
if (!Number.isInteger(timeoutMinutes) || timeoutMinutes <= 0) throw new Error("--timeout-minutes must be positive");

await mkdir(workDir, { recursive: true });
await mkdir(logDir, { recursive: true });
await rm(dbRoot, { recursive: true, force: true });
await rm(resultJson, { force: true });
await rm(sentinelPath, { force: true });

await generateSyntheticVault({
  vaultRoot,
  targetBytes,
  hugeBytes,
  smallFiles,
  reuse: Boolean(values["reuse-vault"]),
});
const vault = await inspectSyntheticVault(vaultRoot);
const expectedSkippedFiles = vault.hugeFiles.map((file) => file.relPath).sort();
let runError = null;
try {
  await runInstalledGate();
} catch (error) {
  runError = error;
}

let resultText;
try {
  resultText = await readFile(resultJson, "utf8");
} catch (error) {
  if (runError) throw runError;
  throw error;
}
const result = JSON.parse(resultText);
const logIssues = await inspectGateProcessLogs();
if (logIssues.length > 0) {
  result.pass = false;
  result.issues = uniqueStrings([...(Array.isArray(result.issues) ? result.issues : []), ...logIssues]);
  await writeFile(resultJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
const evidence = renderEvidence({ result, vault });
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, evidence, "utf8");

console.log(`[phase3-installed-gate] evidence ${evidencePath}`);
console.log(`[phase3-installed-gate] result ${resultJson}`);
console.log(`[phase3-installed-gate] pass ${result.pass ? "yes" : "no"}`);

if (runError && result.pass) {
  throw runError;
}
if (!result.pass) {
  throw new Error(`installed index gate failed: ${result.issues?.join("; ") ?? "unknown issue"}`);
}

async function runInstalledGate() {
  await assertFile(appExecutable, "installed app executable");
  const command = values.xvfb ? "xvfb-run" : appExecutable;
  const args = values.xvfb ? ["-a", appExecutable, ...appArgs] : appArgs;
  const env = {
    ...process.env,
    MEMORY_INDEX_GATE_PROBE: "1",
    MEMORY_INDEX_SEARCH: "1",
    MEMORY_PROCESS_STATS: "1",
    MEMORY_ROOT: vaultRoot,
    MEMORY_INDEX_DB_PATH: indexDbPath,
    MEMORY_INDEX_GATE_RESULT_JSON: resultJson,
    MEMORY_INDEX_GATE_QUERY: query,
    MEMORY_INDEX_GATE_CORPUS_BYTES: String(vault.totalBytes),
    MEMORY_INDEX_GATE_EXPECTED_SKIPPED: JSON.stringify(expectedSkippedFiles),
    MEMORY_LOAD_SEARCH_CORPUS_SENTINEL: sentinelPath,
    MEMORY_INDEX_RECONCILE_DEBOUNCE_MS: "0",
    MEMORY_INDEX_RECONCILE_INTERVAL_MS: "0",
  };
  delete env.MEMORY_CAP_PROBE;
  delete env.MEMORY_CAP_TEST;
  delete env.MEMORY_INDEX_SPIKE;

  console.log(`[phase3-installed-gate] running ${command} ${args.join(" ")}`);
  const stdout = createWriteStream(stdoutPath);
  const stderr = createWriteStream(stderrPath);
  const child = spawn(command, args, {
    cwd: path.dirname(appExecutable),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => {
    stdout.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.write(chunk);
    process.stderr.write(chunk);
  });

  try {
    await waitForProcess(child, timeoutMinutes * 60_000);
  } finally {
    await Promise.all([endWriteStream(stdout), endWriteStream(stderr)]);
  }
  await assertFile(resultJson, "installed index gate result JSON");
}

function endWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function waitForProcess(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`process exited code=${String(code)} signal=${signal ?? "n/a"}`));
      }
    });
  });
}

async function assertFile(filePath, label) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
  } catch (error) {
    throw new Error(`missing ${label}: ${filePath}`, { cause: error });
  }
}

async function inspectGateProcessLogs() {
  const [stdoutLog, stderrLog] = await Promise.all([
    readOptionalText(stdoutPath),
    readOptionalText(stderrPath),
  ]);
  const issues = [];
  const lines = `${stdoutLog}\n${stderrLog}`.split(/\r?\n/u);
  const writerError = lines.find((line) => line.includes("index-writer-error"));
  if (writerError) {
    issues.push(`index-writer emitted error: ${writerError.trim()}`);
  }
  return issues;
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "ENOENT") return "";
    throw error;
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function renderEvidence(input) {
  const { result, vault } = input;
  const service = result.processes?.service;
  const writer = result.processes?.writer;
  return `# Phase 3 Task 6 Installed Index Gate - ${defaultDate}

## Scope

- Part A CI installed-app synthetic gate.
- Installed executable: \`${appExecutable}\`
- MEMORY_INDEX_SEARCH: ${result.runtime?.memoryIndexSearch ?? "unknown"}
- Real A" path: dashboard-service read-only index search + index-writer writable reconcile owner.
- Part B real 754 MB vault: operator-run on the local Windows box; not run by Codex in this CI task.

## Synthetic Vault

- Root: \`${vault.root}\`
- Markdown files: ${vault.fileCount}
- Total corpus bytes: ${formatBytes(vault.totalBytes)} (${vault.totalBytes})
- Pathological files: ${vault.hugeFiles.map((file) => `\`${file.relPath}\` ${formatBytes(file.sizeBytes)}`).join(", ")}
- Expected skipped files: ${(result.expectedSkippedFiles ?? expectedSkippedFiles).map((file) => `\`${file}\``).join(", ") || "none"}

## Assertions

- Pass: ${result.pass ? "yes" : "no"}
- Issues: ${result.issues?.length ? result.issues.join("; ") : "none"}
- Initial index state: ${result.status?.initial?.currentState ?? "unknown"} ready=${String(result.status?.initial?.ready)}
- Final index state: ${result.status?.ready?.currentState ?? "unknown"} ready=${String(result.status?.ready?.ready)} chunks=${result.status?.ready?.chunkCount ?? "unknown"} skipped=${result.status?.ready?.filesSkipped ?? "unknown"}
- Reconcile result: indexed=${result.reconcile?.filesIndexed ?? "unknown"} tombstoned=${result.reconcile?.filesTombstoned ?? "unknown"} chunks=${result.reconcile?.chunks ?? "unknown"} skipped=${result.reconcile?.filesSkipped ?? "unknown"}
- Legacy loadSearchCorpus invocations in index mode: ${result.legacyLoadSearchCorpusInvocations ?? "unknown"}
- First search before ready: ${formatMs(result.firstSearch?.latencyMs)} status=${result.firstSearch?.status ?? "unknown"} degraded=${String(result.firstSearch?.body?.degraded)}
- Final search result count: ${result.finalSearch?.body?.results?.length ?? "unknown"}

## Thresholds

| Metric | Threshold |
| --- | ---: |
| /api/search p50 | <= ${result.thresholds?.searchP50Ms ?? "?"} ms |
| /api/search p95 | <= ${result.thresholds?.searchP95Ms ?? "?"} ms |
| /api/search p99 | <= ${result.thresholds?.searchP99Ms ?? "?"} ms |
| /api/search max | <= ${result.thresholds?.searchMaxMs ?? "?"} ms |
| Reconcile-owner RSS | <= ${formatBytes(result.thresholds?.ownerRssBytes ?? Number.NaN)} |
| used_heap ratio guard | <= ${Math.round((result.thresholds?.ownerUsedHeapToCorpusMax ?? 0) * 100)}% unless under ${formatBytes(result.thresholds?.ownerUsedHeapBytesSoftMax ?? Number.NaN)} |
| Cold full-index target | <= ${formatMs(result.thresholds?.coldFullIndexTargetMs ?? Number.NaN)} (hard ${formatMs(result.thresholds?.coldFullIndexHardMs ?? Number.NaN)}) |

## Metrics

| Metric | Value |
| --- | ---: |
| Search samples while reconcile ran | ${result.search?.count ?? "unknown"} |
| Search errors | ${result.search?.errors ?? "unknown"} |
| Search p50 | ${formatMs(result.search?.p50Ms)} |
| Search p95 | ${formatMs(result.search?.p95Ms)} |
| Search p99 | ${formatMs(result.search?.p99Ms)} |
| Search max | ${formatMs(result.search?.maxMs)} |
| Cold full-index wall-time | ${formatMs(result.coldIndexWallTimeMs)} |
| DB bytes | ${formatBytes(result.dbBytes?.db ?? Number.NaN)} |
| WAL bytes | ${formatBytes(result.dbBytes?.wal ?? Number.NaN)} |
| DB+WAL+SHM bytes | ${formatBytes(result.dbBytes?.total ?? Number.NaN)} |

| Process | PID | RSS peak | external peak | arrayBuffers peak | heapUsed peak | used_heap peak | used_heap/corpus | event-loop p95 | event-loop p99 | event-loop max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${renderProcessRow("dashboard-service", service, vault.totalBytes)}
${renderProcessRow("index-writer", writer, vault.totalBytes)}

## Artifacts

- Result JSON: \`${resultJson}\`
- stdout: \`${stdoutPath}\`
- stderr: \`${stderrPath}\`
`;
}

function renderProcessRow(role, entry, corpusBytes) {
  if (!entry?.stats?.peak) {
    return `| ${role} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`;
  }
  const peak = entry.stats.peak;
  const delay = entry.stats.eventLoopDelay ?? {};
  const ratio = corpusBytes > 0 ? peak.usedHeapSize / corpusBytes : 0;
  return `| ${role} | ${entry.pid ?? "n/a"} | ${formatBytes(peak.rss)} | ${formatBytes(peak.external)} | ${formatBytes(peak.arrayBuffers)} | ${formatBytes(peak.heapUsed)} | ${formatBytes(peak.usedHeapSize)} | ${(ratio * 100).toFixed(2)}% | ${formatMs(delay.p95Ms)} | ${formatMs(delay.p99Ms)} | ${formatMs(delay.maxMs)} |`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`;
  return `${value.toFixed(1)} ms`;
}

function requiredString(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}
