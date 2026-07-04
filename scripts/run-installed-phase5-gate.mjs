#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

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
    "row-count": { type: "string", default: "525345" },
    "duration-minutes": { type: "string", default: "20" },
    "cadence-ms": { type: "string", default: "150" },
    dtype: { type: "string", default: "binary" },
    "binary-oversample-factor": { type: "string", default: "2" },
    "evidence-json": { type: "string" },
    "evidence-path": { type: "string" },
    "log-dir": { type: "string" },
    "timeout-minutes": { type: "string", default: "35" },
    "xvfb": { type: "boolean", default: false },
  },
});

const appExecutable = requiredString(values["app-executable"], "--app-executable");
const rowCount = readPositiveInt(values["row-count"], "--row-count");
const durationMinutes = Number(values["duration-minutes"]);
const cadenceMs = readPositiveInt(values["cadence-ms"], "--cadence-ms");
const dtype = readDtype(values.dtype);
const binaryOversampleFactor = readPositiveInt(values["binary-oversample-factor"], "--binary-oversample-factor");
const timeoutMinutes = readPositiveInt(values["timeout-minutes"], "--timeout-minutes");
if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error("--duration-minutes must be positive");

const workDir = path.resolve(values["work-dir"] ?? path.join(tmpdir(), `memory-fort-phase5-gate-${defaultDate}`));
const dbPath = path.join(workDir, "phase5", "phase5-vectors.sqlite");
const resultJson = path.resolve(values["evidence-json"] ?? path.join(workDir, "phase5-gate-result.json"));
const evidencePath = path.resolve(
  values["evidence-path"] ?? path.join(repoRoot, "docs", "release-evidence", `phase5-task0-${defaultDate}.md`),
);
const logDir = path.resolve(values["log-dir"] ?? path.join(workDir, "logs"));
const stdoutPath = path.join(logDir, "phase5-gate.stdout.log");
const stderrPath = path.join(logDir, "phase5-gate.stderr.log");
const appArgs = Array.isArray(values["app-arg"]) ? values["app-arg"].map(String) : [];

await mkdir(workDir, { recursive: true });
await mkdir(logDir, { recursive: true });
await rm(resultJson, { force: true });

await runInstalledGate();
const result = JSON.parse(await readFile(resultJson, "utf8"));
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, renderEvidence(result), "utf8");

console.log(`[phase5-gate] evidence ${evidencePath}`);
console.log(`[phase5-gate] result ${resultJson}`);
console.log(`[phase5-gate] pass ${result.pass ? "yes" : "no"}`);

if (!result.pass) {
  throw new Error(`phase5 gate failed: ${Array.isArray(result.issues) ? result.issues.join("; ") : "unknown issue"}`);
}

async function runInstalledGate() {
  await assertFile(appExecutable, "installed app executable");
  const command = values.xvfb ? "xvfb-run" : appExecutable;
  const args = values.xvfb ? ["-a", appExecutable, ...appArgs] : appArgs;
  const env = {
    ...process.env,
    MEMORY_PHASE5_GATE_PROBE: "1",
    MEMORY_PHASE5_GATE_RESULT_JSON: resultJson,
    MEMORY_PHASE5_GATE_DB_PATH: dbPath,
    MEMORY_PHASE5_GATE_ROWS: String(rowCount),
    MEMORY_PHASE5_GATE_DURATION_MS: String(Math.round(durationMinutes * 60_000)),
    MEMORY_PHASE5_GATE_CADENCE_MS: String(cadenceMs),
    MEMORY_PHASE5_GATE_DTYPE: dtype,
    MEMORY_PHASE5_GATE_BINARY_OVERSAMPLE: String(binaryOversampleFactor),
  };
  delete env.MEMORY_CAP_PROBE;
  delete env.MEMORY_CAP_TEST;
  delete env.MEMORY_INDEX_SPIKE;
  delete env.MEMORY_INDEX_GATE_PROBE;

  console.log(`[phase5-gate] running ${command} ${args.join(" ")}`);
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
  await assertFile(resultJson, "phase5 gate result JSON");
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
      if (code === 0) resolve();
      else reject(new Error(`process exited code=${String(code)} signal=${signal ?? "n/a"}`));
    });
  });
}

function endWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
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

function renderEvidence(result) {
  const dashboard = result.processes?.dashboard;
  const writer = result.processes?.writer;
  const dbBytes = dashboard?.metrics?.dbBytes ?? {};
  const writerDbBytes = writer?.metrics?.dbBytes ?? {};
  const resultDtype = result.config?.dtype ?? dashboard?.dtype ?? dtype;
  const resultOversample = result.config?.binaryOversampleFactor ?? dashboard?.binaryOversampleFactor ?? binaryOversampleFactor;
  const eventLoopP95 = Number(dashboard?.stats?.eventLoopDelay?.p95Ms);
  const eventLoopThreshold = Number(result.thresholds?.dashboardEventLoopP95Ms);
  const d5Decision = Number.isFinite(eventLoopP95) && Number.isFinite(eventLoopThreshold)
    ? (eventLoopP95 <= eventLoopThreshold ? "inline acceptable under this gate" : "dedicated process required by this gate")
    : "undetermined";
  return `# Phase 5 Task 0 Packaged Contention Gate - ${defaultDate}

## Scope

- Installed executable: \`${appExecutable}\`
- Dashboard entry: \`${result.runtime?.servicePath ?? "unknown"}\`
- Writer entry: \`${result.runtime?.writerPath ?? "unknown"}\`
- dtype: ${resultDtype}
- Binary oversample factor: ${resultDtype === "binary" ? resultOversample : "n/a"}
- Synthetic vector rows: ${result.config?.rowCount ?? "unknown"}
- Dimension: ${result.config?.dim ?? "unknown"}
- Duration: ${formatMs(result.config?.durationMs)}
- Cadence: ${formatMs(result.config?.cadenceMs)}
- DB path: \`${result.config?.dbPath ?? dbPath}\`

## Decision

- Pass: ${result.pass ? "yes" : "no"}
- Issues: ${result.issues?.length ? result.issues.join("; ") : "none"}
- D1 storage decision: ${resultDtype === "binary" ? "binary coarse + stored int8 rescore measured in this run" : `${resultDtype} baseline measured in this run`}
- D2 latency decision: KNN p95 ${formatMs(dashboard?.metrics?.knnService?.p95Ms)} vs ${formatMs(result.thresholds?.searchP95Ms)}
- D5 service decision: ${d5Decision} (event-loop p95 ${formatMs(eventLoopP95)})

## Thresholds

| Metric | Threshold |
| --- | ---: |
| Dashboard KNN p95 | <= ${formatMs(result.thresholds?.searchP95Ms)} |
| Dashboard non-search p95 | <= ${formatMs(result.thresholds?.nonSearchP95Ms)} |
| Dashboard event-loop p95 | <= ${formatMs(result.thresholds?.dashboardEventLoopP95Ms)} |
| Combined dashboard+writer RSS | <= ${formatBytes(result.thresholds?.combinedRssBytes)} |
| Writer docs/sec advisory target | ${formatNumber(result.thresholds?.advisoryWriterDocsPerSecond)} |

## Metrics

| Metric | Value |
| --- | ---: |
| dtype | ${resultDtype} |
| Binary oversample factor | ${resultDtype === "binary" ? resultOversample : "n/a"} |
| Dashboard model load | ${formatMs(dashboard?.modelLoadMs)} |
| Writer model load | ${formatMs(writer?.modelLoadMs)} |
| Search count | ${dashboard?.metrics?.searchCount ?? "unknown"} |
| HTTP /api/search p50 | ${formatMs(dashboard?.metrics?.search?.p50Ms)} |
| HTTP /api/search p95 | ${formatMs(dashboard?.metrics?.search?.p95Ms)} |
| HTTP /api/search p99 | ${formatMs(dashboard?.metrics?.search?.p99Ms)} |
| Query embedding p95 | ${formatMs(dashboard?.metrics?.queryEmbeddingService?.p95Ms)} |
| KNN p95 | ${formatMs(dashboard?.metrics?.knnService?.p95Ms)} |
| Non-search p95 | ${formatMs(dashboard?.metrics?.nonSearchApi?.p95Ms)} |
| Search samples/errors | ${dashboard?.metrics?.search?.count ?? "unknown"} / ${dashboard?.metrics?.search?.errors ?? "unknown"} |
| Non-search samples/errors | ${dashboard?.metrics?.nonSearchApi?.count ?? "unknown"} / ${dashboard?.metrics?.nonSearchApi?.errors ?? "unknown"} |
| Dashboard service search p95 | ${formatMs(dashboard?.metrics?.searchService?.p95Ms)} |
| Dashboard event-loop p95 | ${formatMs(dashboard?.stats?.eventLoopDelay?.p95Ms)} |
| Writer docs/sec | ${formatNumber(writer?.metrics?.docsPerSecond)} |
| Writer projected backfill | ${formatMinutes(writer?.metrics?.projectedBackfillMinutes)} |
| Writer tokens/sec | ${formatNumber(writer?.metrics?.tokensPerSecond)} |
| Writer inserted rows | ${writer?.metrics?.inserted ?? "unknown"} |
| Dashboard CPU | ${formatPercent(dashboard?.stats?.cpu?.cpuPercent)} |
| Writer CPU | ${formatPercent(writer?.stats?.cpu?.cpuPercent)} |
| Dashboard OS threads | ${dashboard?.stats?.threadCount ?? "unknown"} |
| Writer OS threads | ${writer?.stats?.threadCount ?? "unknown"} |
| Dashboard RSS peak | ${formatBytes(dashboard?.stats?.peakRssBytes)} |
| Writer RSS peak | ${formatBytes(writer?.stats?.peakRssBytes)} |
| Main RSS | ${formatBytes(result.processes?.main?.rssBytes)} |
| Combined dashboard+writer RSS peak | ${formatBytes(result.rss?.combinedDashboardWriterPeakBytes ?? ((dashboard?.stats?.peakRssBytes ?? 0) + (writer?.stats?.peakRssBytes ?? 0)))} |
| Total app RSS peak | ${formatBytes(result.rss?.totalAppPeakBytes)} |
| Dashboard-view DB bytes | ${formatBytes(dbBytes.db)} |
| Dashboard-view WAL bytes | ${formatBytes(dbBytes.wal)} |
| Dashboard-view SHM bytes | ${formatBytes(dbBytes.shm)} |
| Dashboard-view DB+WAL+SHM bytes | ${formatBytes(dbBytes.total)} |
| Writer-view DB+WAL+SHM bytes | ${formatBytes(writerDbBytes.total)} |

## Artifacts

- Result JSON: \`${resultJson}\`
- stdout: \`${stdoutPath}\`
- stderr: \`${stderrPath}\`
`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "n/a";
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "n/a";
}

function formatMinutes(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)} min` : "n/a";
}

function formatMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  if (number >= 60_000) return `${(number / 60_000).toFixed(2)} min`;
  return `${number.toFixed(1)} ms`;
}

function formatBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB"];
  let current = number;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function requiredString(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function readDtype(value) {
  const dtype = String(value ?? "").trim() || "binary";
  if (dtype === "binary" || dtype === "int8" || dtype === "float32") return dtype;
  throw new Error(`--dtype must be binary, int8, or float32; got ${dtype}`);
}

function readPositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
