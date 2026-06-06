import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../storage/atomic-write.js";

export const PROMPT_CUSTOM_MARKER_RE = /^#\s*memory:custom\b/im;
const PROMPT_TEMPLATE_SENTINEL_RE = /^<!--\s*memory:template\s+([^>]+?)\s*-->\s*$/im;

export interface RuntimePromptOptions {
  vaultRoot: string;
  name: string;
  sourceRepoDir?: string;
  warn?: (message: string) => void;
}

export interface RuntimePromptResult {
  content: string;
  source: "bundled" | "vault";
  vaultPath: string;
  templatePath?: string;
}

export interface PromptSyncAction {
  name: string;
  action: "copy" | "unchanged" | "skip-custom";
  path: string;
}

export async function readRuntimePrompt(opts: RuntimePromptOptions): Promise<RuntimePromptResult> {
  const vaultPath = join(opts.vaultRoot, "prompts", opts.name);
  const templatePath = bundledPromptPath(opts.name, opts.sourceRepoDir);
  const vaultExists = existsSync(vaultPath);
  const templateExists = existsSync(templatePath);
  const vaultContent = vaultExists ? await readFile(vaultPath, "utf-8") : null;
  const templateContent = templateExists ? await readFile(templatePath, "utf-8") : null;

  if (vaultContent !== null && isPromptCustomized(vaultContent)) {
    return { content: vaultContent, source: "vault", vaultPath, ...(templateExists ? { templatePath } : {}) };
  }

  if (templateContent !== null) {
    warnIfMissingCurrentSentinel({
      name: opts.name,
      vaultContent,
      templateContent,
      warn: opts.warn,
    });
    return { content: templateContent, source: "bundled", vaultPath, templatePath };
  }

  if (vaultContent !== null) {
    return { content: vaultContent, source: "vault", vaultPath };
  }

  throw new Error(`missing prompt at ${vaultPath}`);
}

export async function listPromptSyncActions(opts: {
  vaultRoot: string;
  sourceRepoDir?: string;
}): Promise<Array<PromptSyncAction & { content?: string }>> {
  const templateDir = bundledPromptsDir(opts.sourceRepoDir);
  if (!existsSync(templateDir)) return [];
  const names = (await readdir(templateDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const actions: Array<PromptSyncAction & { content?: string }> = [];
  for (const name of names) {
    const templatePath = join(templateDir, name);
    const vaultPath = join(opts.vaultRoot, "prompts", name);
    const content = await readFile(templatePath, "utf-8");
    const path = `prompts/${name}`;
    if (existsSync(vaultPath)) {
      const current = await readFile(vaultPath, "utf-8");
      if (isPromptCustomized(current)) {
        actions.push({ name, action: "skip-custom", path });
        continue;
      }
      if (current === content) {
        actions.push({ name, action: "unchanged", path });
        continue;
      }
    }
    actions.push({ name, action: "copy", path, content });
  }
  return actions;
}

export async function findPromptDrift(opts: {
  vaultRoot: string;
  sourceRepoDir?: string;
}): Promise<string[]> {
  const actions = await listPromptSyncActions(opts);
  return actions
    .filter((action) => action.action === "copy")
    .map((action) => action.path);
}

export async function copyBundledPrompt(opts: {
  vaultRoot: string;
  action: PromptSyncAction & { content?: string };
}): Promise<void> {
  if (opts.action.action !== "copy" || opts.action.content === undefined) return;
  const fullPath = join(opts.vaultRoot, ...opts.action.path.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await atomicWrite(fullPath, opts.action.content);
}

export function isPromptCustomized(content: string): boolean {
  return PROMPT_CUSTOM_MARKER_RE.test(content);
}

export function bundledPromptPath(name: string, sourceRepoDir?: string): string {
  return join(bundledPromptsDir(sourceRepoDir), name);
}

export function bundledPromptsDir(sourceRepoDir?: string): string {
  if (sourceRepoDir) return join(sourceRepoDir, "templates", "prompts");
  const local = resolve(process.cwd(), "templates", "prompts");
  if (existsSync(local)) return local;
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
    "prompts",
  );
}

function warnIfMissingCurrentSentinel(opts: {
  name: string;
  vaultContent: string | null;
  templateContent: string;
  warn?: (message: string) => void;
}): void {
  if (!opts.vaultContent || !opts.warn) return;
  const sentinel = PROMPT_TEMPLATE_SENTINEL_RE.exec(opts.templateContent)?.[0];
  if (!sentinel || opts.vaultContent.includes(sentinel)) return;
  opts.warn(
    `memory prompt warning: prompts/${opts.name} is missing the current template sentinel; ` +
      "using bundled template. Run `memory sync-prompts --apply` to refresh uncustomized vault prompts.",
  );
}
