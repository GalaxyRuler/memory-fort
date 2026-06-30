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
const defaultChunkBytes = 64 * 1024;
const defaultChunksPerTxn = 32;
const defaultDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const { values } = parseArgs({
  options: {
    "work-dir": { type: "string" },
    "target-mib": { type: "string", default: "750" },
    "huge-mib": { type: "string", default: "150" },
    "small-files": { type: "string", default: String(defaultSmallFiles) },
    "chunk-kib": { type: "string", default: "64" },
    "chunks-per-txn": { type: "string", default: String(defaultChunksPerTxn) },
    "query": { type: "string", default: "needle" },
    "evidence-path": {
      type: "string",
      default: path.join(repoRoot, "docs", "release-evidence", `phase3-spike-${defaultDate}.md`),
    },
    "reuse-vault": { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
    "skip-package": { type: "boolean", default: false },
    "timeout-minutes": { type: "string", default: "30" },
  },
});

const targetBytes = Number(values["target-mib"]) * MiB;
const hugeBytes = Number(values["huge-mib"]) * MiB;
const smallFiles = Number.parseInt(values["small-files"], 10);
const chunkBytes = Number(values["chunk-kib"]) * 1024;
const chunksPerTxn = Number.parseInt(values["chunks-per-txn"], 10);
const timeoutMinutes = Number.parseInt(values["timeout-minutes"], 10);
const workDir = path.resolve(
  values["work-dir"] ?? path.join(tmpdir(), `memory-fort-phase3-spike-${defaultDate}`),
);
const vaultRoot = path.join(workDir, "synthetic-vault");
const dbRoot = path.join(workDir, "db");
const resultJson = path.join(workDir, "result.json");
const evidencePath = path.resolve(values["evidence-path"]);

if (!Number.isFinite(targetBytes) || targetBytes <= 0) throw new Error("--target-mib must be positive");
if (!Number.isFinite(hugeBytes) || hugeBytes <= 0) throw new Error("--huge-mib must be positive");
if (!Number.isInteger(smallFiles) || smallFiles <= 0) throw new Error("--small-files must be positive");
if (hugeBytes >= targetBytes) throw new Error("--huge-mib must be smaller than --target-mib");
if (!Number.isFinite(chunkBytes) || chunkBytes <= 0) throw new Error("--chunk-kib must be positive");
if (!Number.isInteger(chunksPerTxn) || chunksPerTxn <= 0) throw new Error("--chunks-per-txn must be positive");

const commands = [];

await generateSyntheticVault({
  vaultRoot,
  targetBytes,
  hugeBytes,
  smallFiles,
  reuse: Boolean(values["reuse-vault"]),
});
const vault = await inspectSyntheticVault(vaultRoot);

if (!values["skip-build"]) {
  await runCommand(npmCmd(), ["run", "build"]);
  await runCommand(npmCmd(), ["run", "electron:rebuild"]);
}
if (!values["skip-package"]) {
  await runCommand(npxCmd(), ["electron-builder", "build", "--win", "dir", "--x64", "--publish", "never"]);
}

await rm(dbRoot, { recursive: true, force: true });
await mkdir(dbRoot, { recursive: true });
await rm(resultJson, { force: true });

const executable = path.join(repoRoot, "dist", "electron-installer", "win-unpacked", "MemoryFort.exe");
await assertFile(executable, "packaged MemoryFort executable");

await runPackagedSpike(executable, {
  vaultRoot,
  dbRoot,
  resultJson,
  query: String(values.query ?? "needle"),
  chunkBytes,
  chunksPerTxn,
  timeoutMs: timeoutMinutes * 60_000,
});

const result = JSON.parse(await readFile(resultJson, "utf8"));
const evidence = renderEvidence({
  result,
  vault,
  workDir,
  executable,
  commands,
  chunkBytes,
  chunksPerTxn,
});
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, evidence, "utf8");

console.log(`[phase3-spike] evidence ${evidencePath}`);
console.log(`[phase3-spike] recommendation ${result.recommendation}`);

async function runCommand(command, args) {
  commands.push(`${command} ${args.join(" ")}`);
  console.log(`[phase3-spike] ${command} ${args.join(" ")}`);
  const spawnSpec = commandForPlatform(command, args);
  await waitForProcess(spawn(spawnSpec.command, spawnSpec.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_BUILDER_DISABLE_SIGNING: "true",
    },
    stdio: "inherit",
    windowsHide: true,
  }));
}

function commandForPlatform(command, args) {
  if (process.platform !== "win32") return { command, args };
  const comspec = process.env.ComSpec || "cmd.exe";
  const commandLine = [command, ...args].map(quoteCmdArg).join(" ");
  return { command: comspec, args: ["/d", "/s", "/c", commandLine] };
}

function quoteCmdArg(value) {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

async function runPackagedSpike(executable, opts) {
  const env = {
    ...process.env,
    MEMORY_INDEX_SPIKE: "1",
    MEMORY_INDEX_SPIKE_VAULT: opts.vaultRoot,
    MEMORY_INDEX_SPIKE_DB_ROOT: opts.dbRoot,
    MEMORY_INDEX_SPIKE_RESULT_JSON: opts.resultJson,
    MEMORY_INDEX_SPIKE_QUERY: opts.query,
    MEMORY_INDEX_SPIKE_CHUNK_BYTES: String(opts.chunkBytes),
    MEMORY_INDEX_SPIKE_CHUNKS_PER_TXN: String(opts.chunksPerTxn),
  };
  commands.push(`${executable} (MEMORY_INDEX_SPIKE=1)`);
  console.log(`[phase3-spike] running packaged spike ${executable}`);
  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  await waitForProcess(child, opts.timeoutMs);
  await assertFile(opts.resultJson, "spike result JSON");
}

function waitForProcess(child, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`process timed out after ${timeoutMs}ms`));
      }, timeoutMs)
      : null;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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

function renderEvidence(input) {
  const { result, vault } = input;
  const optionB = result.options?.B;
  const optionA = result.options?.["A\""];
  const recommendation = result.recommendation === "B"
    ? "Option B (bounded in-service dashboard-service utilityProcess)"
    : result.recommendation === "A\""
      ? "Option A\" (second utilityProcess writer with read-only service connection)"
      : "BLOCKED";

  return `# Phase 3 Task 0 D1 Packaged Concurrency Spike - ${defaultDate}

## Scope

- Task: D1 concurrency decision before any \`src/index/**\` feature code.
- Packaged runtime: ${result.runtime?.packaged ? "yes" : "no"}.
- worker_thread: excluded by plan because packaged Electron cannot resolve better-sqlite3 there (electron#43513); not spiked as a candidate.
- Controller: \`scripts/spike-index-concurrency.mjs\`.
- Temporary utilityProcess child: \`src/dashboard/index-concurrency-spike.ts\`.

## Synthetic Vault

- Root: \`${vault.root}\`
- Markdown files: ${vault.fileCount}
- Total corpus bytes: ${formatBytes(vault.totalBytes)} (${vault.totalBytes})
- Pathological files: ${vault.hugeFiles.map((file) => `\`${file.relPath}\` ${formatBytes(file.sizeBytes)}`).join(", ")}
- Chunking during spike: ${formatBytes(input.chunkBytes)} chunks, ${input.chunksPerTxn} chunks per transaction, \`setImmediate\` yield between transactions.

## Packaged Run

- Executable: \`${input.executable}\`
- App path: \`${result.runtime?.appPath ?? "unknown"}\`
- Electron: ${result.runtime?.electron ?? "unknown"}
- Node: ${result.runtime?.node ?? "unknown"}
- Platform: ${result.runtime?.platform ?? "unknown"} ${result.runtime?.arch ?? "unknown"}
- Commands:
${input.commands.map((command) => `  - \`${command}\``).join("\n")}

## Thresholds

| Metric | Threshold |
| --- | ---: |
| /api/search p50 | <= ${result.thresholds.searchP50Ms} ms |
| /api/search p95 | <= ${result.thresholds.searchP95Ms} ms |
| /api/search p99 | <= ${result.thresholds.searchP99Ms} ms |
| /api/search max | <= ${result.thresholds.searchMaxMs} ms |
| Reconcile-owner RSS | <= ${formatBytes(result.thresholds.ownerRssBytes)} |
| Reconcile-owner used_heap | not corpus-proportional (${Math.round(result.thresholds.ownerUsedHeapToCorpusMax * 100)}% ratio guard plus ${formatBytes(result.thresholds.ownerUsedHeapBytesSoftMax)} soft guard) |
| Cold full-index target | <= ${formatMs(result.thresholds.coldFullIndexTargetMs)} (hard <= ${formatMs(result.thresholds.coldFullIndexHardMs)}) |

## Results

| Option | Ran | Pass | Search samples | p50 | p95 | p99 | max | RSS peak | used_heap peak | DB+WAL | Cold full-index |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${renderOptionRow(optionB)}
${renderOptionRow(optionA)}

## Option B Detail

${renderOptionDetail(optionB)}

## Option A" Detail

${renderOptionDetail(optionA)}

## D1 Recommendation

GO with **${recommendation}**.

Rationale: ${renderRationale(optionB, optionA, result.recommendation)}

## Stop Point

Stopped after Task 0. No Task 1 schema/search/reconcile feature code was added under \`src/index/**\`, and no version bump or release work was performed.
`;
}

function renderOptionRow(option) {
  if (!option || option.ran === false) {
    return `| A" | no | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`;
  }
  return `| ${option.label} | yes | ${option.pass ? "PASS" : "FAIL"} | ${option.search.count} | ${formatMs(option.search.p50Ms)} | ${formatMs(option.search.p95Ms)} | ${formatMs(option.search.p99Ms)} | ${formatMs(option.search.maxMs)} | ${formatBytes(option.child.owner.peak.rss)} | ${formatBytes(option.child.owner.peak.usedHeapSize)} | ${formatBytes(option.child.dbBytes.total)} | ${formatMs(option.child.wallTimeMs)} |`;
}

function renderOptionDetail(option) {
  if (!option || option.ran === false) {
    return `Not run. ${option?.reason ?? "Option B result did not require fallback."}`;
  }
  const usedHeapRatio = option.child.totalBytes > 0
    ? option.child.owner.peak.usedHeapSize / option.child.totalBytes
    : 0;
  return [
    `- Pass: ${option.pass ? "yes" : "no"}`,
    `- Issues: ${option.issues.length ? option.issues.join("; ") : "none"}`,
    `- Files indexed: ${option.child.filesIndexed}`,
    `- Chunks indexed: ${option.child.chunksIndexed}`,
    `- Transactions: ${option.child.transactions}`,
    `- Search latency: p50 ${formatMs(option.search.p50Ms)}, p95 ${formatMs(option.search.p95Ms)}, p99 ${formatMs(option.search.p99Ms)}, max ${formatMs(option.search.maxMs)}, errors ${option.search.errors}`,
    `- Event-loop delay: p95 ${formatMs(option.child.owner.eventLoopDelay.p95Ms)}, p99 ${formatMs(option.child.owner.eventLoopDelay.p99Ms)}, max ${formatMs(option.child.owner.eventLoopDelay.maxMs)}`,
    `- Memory peak: rss ${formatBytes(option.child.owner.peak.rss)}, external ${formatBytes(option.child.owner.peak.external)}, arrayBuffers ${formatBytes(option.child.owner.peak.arrayBuffers)}, heapUsed ${formatBytes(option.child.owner.peak.heapUsed)}, used_heap ${formatBytes(option.child.owner.peak.usedHeapSize)} (${(usedHeapRatio * 100).toFixed(2)}% of corpus bytes)`,
    `- DB bytes: db ${formatBytes(option.child.dbBytes.db)}, wal ${formatBytes(option.child.dbBytes.wal)}, shm ${formatBytes(option.child.dbBytes.shm)}, total ${formatBytes(option.child.dbBytes.total)}`,
    `- Cold full-index wall-time: ${formatMs(option.child.wallTimeMs)}`,
  ].join("\n");
}

function renderRationale(optionB, optionA, recommendation) {
  if (recommendation === "B") {
    return "Option B met the search latency, reconcile-owner RSS, used_heap, and cold-index thresholds, including the pathological huge file under bounded transactions. Option A\" was not needed.";
  }
  if (recommendation === "A\"") {
    return `Option B missed: ${optionB.issues.join("; ")}. Option A\" met the same thresholds by isolating the single WAL writer in a second utilityProcess.`;
  }
  return `No option met thresholds. Option B issues: ${optionB?.issues?.join("; ") ?? "n/a"}. Option A\" issues: ${optionA?.issues?.join("; ") ?? "n/a"}.`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`;
  return `${value.toFixed(1)} ms`;
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCmd() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
