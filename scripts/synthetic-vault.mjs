import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MiB = 1024 * 1024;
export const defaultTargetBytes = 750 * MiB;
export const defaultHugeBytes = 150 * MiB;
export const defaultSmallFiles = 3000;

export async function generateSyntheticVault(opts) {
  if (!opts.reuse) {
    await rm(opts.vaultRoot, { recursive: true, force: true });
  }
  const manifestPath = path.join(opts.vaultRoot, ".spike-manifest.json");
  if (opts.reuse) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (
        manifest.targetBytes === opts.targetBytes &&
        manifest.hugeBytes === opts.hugeBytes &&
        manifest.smallFiles === opts.smallFiles
      ) {
        console.log(`[phase3-synthetic-vault] reusing synthetic vault ${opts.vaultRoot}`);
        return;
      }
    } catch {
      // Regenerate below.
    }
    await rm(opts.vaultRoot, { recursive: true, force: true });
  }

  console.log(`[phase3-synthetic-vault] generating synthetic vault ${formatBytes(opts.targetBytes)}`);
  const smallRoot = path.join(opts.vaultRoot, "wiki", "small");
  const hugeRoot = path.join(opts.vaultRoot, "wiki", "pathological");
  await mkdir(smallRoot, { recursive: true });
  await mkdir(hugeRoot, { recursive: true });

  const smallTotal = opts.targetBytes - opts.hugeBytes;
  const baseSmallBytes = Math.floor(smallTotal / opts.smallFiles);
  const remainder = smallTotal % opts.smallFiles;
  for (let i = 0; i < opts.smallFiles; i += 1) {
    const size = baseSmallBytes + (i < remainder ? 1 : 0);
    const bucket = String(Math.floor(i / 250)).padStart(2, "0");
    const dir = path.join(smallRoot, bucket);
    await mkdir(dir, { recursive: true });
    await writeSyntheticFile(
      path.join(dir, `note-${String(i).padStart(5, "0")}.md`),
      size,
      `small-${i}`,
    );
    if ((i + 1) % 250 === 0) {
      console.log(`[phase3-synthetic-vault] generated ${i + 1}/${opts.smallFiles} small files`);
    }
  }

  await writeSyntheticFile(
    path.join(hugeRoot, "pathological-150mb.md"),
    opts.hugeBytes,
    "pathological-huge",
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      generator: "phase3-synthetic-vault-v1",
      targetBytes: opts.targetBytes,
      hugeBytes: opts.hugeBytes,
      smallFiles: opts.smallFiles,
    }, null, 2)}\n`,
    "utf8",
  );
}

export async function inspectSyntheticVault(root) {
  const files = [];
  await walk(root);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const huge = files.filter((file) => file.sizeBytes >= 100 * MiB).sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    root,
    fileCount: files.length,
    totalBytes,
    hugeFiles: huge.slice(0, 5),
  };

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(entryPath);
        files.push({
          path: entryPath,
          relPath: path.relative(root, entryPath).replace(/\\/g, "/"),
          sizeBytes: info.size,
        });
      }
    }
  }
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 1024 * MiB) return `${(value / (1024 * MiB)).toFixed(2)} GiB`;
  if (value >= MiB) return `${(value / MiB).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${value} B`;
}

async function writeSyntheticFile(filePath, sizeBytes, label) {
  const stream = createWriteStream(filePath, { flags: "w" });
  const pattern = Buffer.from(
    [
      `# ${label}`,
      "",
      "needle phase3 lexical index concurrency sqlite wal dashboard utility process search responsiveness.",
      "This synthetic markdown paragraph repeats stable ASCII tokens for FTS5 bm25 measurement.",
      "bounded transaction chunking should keep the huge file from freezing search.",
      "",
    ].join("\n"),
    "utf8",
  );
  let remaining = sizeBytes;
  while (remaining > 0) {
    const chunk = remaining >= pattern.length ? pattern : pattern.subarray(0, remaining);
    if (!stream.write(chunk)) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
    remaining -= chunk.length;
  }
  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.once("error", reject);
  });
}
