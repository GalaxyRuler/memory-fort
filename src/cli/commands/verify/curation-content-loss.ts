import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../../../storage/frontmatter.js";
import { pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const ID = "curation.content-loss";

export const curationContentLossCheck: CheckDescriptor = {
  id: ID,
  label: "curation rewrite content-loss guard",
  roles: ["operator", "server"],
  run: checkCurationContentLoss,
};

async function checkCurationContentLoss(ctx: VerifyCheckContext): Promise<VerifyCheckResult> {
  const historyRoot = join(ctx.vaultRoot, "wiki", ".history");
  if (!existsSync(historyRoot)) {
    return pass(ID, "curation content-loss: no rewrite history");
  }

  const latestByCanonical = new Map<string, string>();
  for (const historyFile of await listMarkdownFiles(historyRoot)) {
    const rel = relative(historyRoot, historyFile).replace(/\\/g, "/");
    const parts = rel.split("/");
    const timestamp = parts.at(-1);
    if (!timestamp?.endsWith(".md")) continue;
    const canonical = parts.slice(0, -1).join("/");
    if (!canonical.startsWith("wiki/") || !canonical.endsWith(".md")) continue;
    const previous = latestByCanonical.get(canonical);
    if (!previous || historyFile.localeCompare(previous) > 0) {
      latestByCanonical.set(canonical, historyFile);
    }
  }

  const risky: string[] = [];
  for (const [canonical, historyFile] of latestByCanonical) {
    const canonicalPath = join(ctx.vaultRoot, ...canonical.split("/"));
    if (!existsSync(canonicalPath)) continue;
    const current = parseFrontmatter(await readFile(canonicalPath, "utf-8"));
    const history = parseFrontmatter(await readFile(historyFile, "utf-8"));
    const historyLength = substantiveLength(history.body);
    if (historyLength === 0) continue;
    const ratio = substantiveLength(current.body) / historyLength;
    if (ratio < 0.6) risky.push(canonical);
  }

  if (risky.length === 0) {
    return pass(ID, "curation content-loss: latest rewrites within shrink threshold");
  }
  return warn(
    ID,
    `curation content-loss: ${risky.length} page${risky.length === 1 ? "" : "s"} below rewrite shrink threshold`,
    risky.join(", "),
  );
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function substantiveLength(text: string): number {
  return text
    .replace(/^##\s+\d{4}-\d{2}-\d{2}.*$/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[`*_~[\]()#>:.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .length;
}
