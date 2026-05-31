import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  applyCompileOperations,
  parseCompileOperationBlock,
  type CompileOperation,
  type CompileOperationOutcomeKind,
} from "../../compile/execute.js";
import { chatWithAudit } from "../../llm/audit.js";
import {
  createLLMFromConfig,
  getActiveLLMConfig,
  type LLMConfig,
} from "../../llm/factory.js";
import type { LLMProvider } from "../../llm/types.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import { parseFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot } from "../../storage/paths.js";

export interface CurateOptions {
  vaultRoot?: string;
  target?: string;
  all?: boolean;
  plan?: boolean;
  apply?: boolean;
  sectionThreshold?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  configLoader?: () => Promise<MemoryConfig>;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
}

export interface CuratePageResult {
  path: string;
  outcome: CompileOperationOutcomeKind;
  proposed: boolean;
}

export interface CurateResult {
  mode: "plan" | "apply";
  pages: CuratePageResult[];
}

const DEFAULT_SECTION_THRESHOLD = 8;

export async function runCurate(opts: CurateOptions = {}): Promise<CurateResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const mode = opts.apply ? "apply" : "plan";
  const targets = opts.all
    ? await listBloatedWikiPages(root, opts.sectionThreshold ?? DEFAULT_SECTION_THRESHOLD)
    : [await resolveCurateTarget(root, opts.target)];
  const pages: CuratePageResult[] = [];

  for (const target of targets) {
    const operation = await requestCuratedRewrite(root, target, opts);
    const withConfidence = {
      ...operation,
      frontmatter: {
        ...operation.frontmatter,
        confidence: typeof operation.frontmatter?.confidence === "number" ? operation.frontmatter.confidence : 0.9,
      },
    };
    const applied = await applyCompileOperations({
      vaultRoot: root,
      operations: [withConfidence],
      plan: mode === "plan",
      now: opts.now,
    });
    const outcome = applied.outcomes.find((item) => item.path === target);
    pages.push({
      path: target,
      outcome: outcome?.outcome ?? (mode === "plan" ? "staged-for-review" : "rejected"),
      proposed: applied.proposed.length > 0,
    });
  }

  return { mode, pages };
}

export function formatCurateResult(result: CurateResult): string {
  const lines = [
    `Curate ${result.mode} complete`,
    `  pages: ${result.pages.length}`,
  ];
  for (const page of result.pages) {
    lines.push(`  - ${page.outcome}: ${page.path}${page.proposed ? " (staged)" : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

async function requestCuratedRewrite(
  root: string,
  target: string,
  opts: CurateOptions,
): Promise<Extract<CompileOperation, { kind: "rewrite_page" }>> {
  const fullPath = join(root, ...target.split("/"));
  if (!existsSync(fullPath)) {
    throw new Error(`memory curate: page not found: ${target}`);
  }
  const current = await readFile(fullPath, "utf-8");
  const parsedPage = parseFrontmatter(current);
  const env = opts.env ?? process.env;
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
  const llmConfig = getActiveLLMConfig(config);
  const llm = (opts.llmFactory ?? createLLMFromConfig)(llmConfig, env);
  const response = await chatWithAudit({
    llm,
    vaultRoot: root,
    consumer: "curate-merge",
    request: {
      messages: [
        {
          role: "system",
          content: "Return only one fenced compile-op JSON block with a rewrite_page operation.",
        },
        {
          role: "user",
          content: [
            "Consolidate this wiki page into one coherent article.",
            "Preserve every substantive fact. Remove redundant dated update sections.",
            `Path: ${target}`,
            "",
            "Current frontmatter:",
            "```json",
            JSON.stringify(parsedPage.frontmatter, null, 2),
            "```",
            "",
            "Current body:",
            "```markdown",
            parsedPage.body,
            "```",
          ].join("\n"),
        },
      ],
      maxTokens: llmConfig?.max_tokens,
      temperature: llmConfig?.temperature,
    },
    env,
  });
  const parsed = parseCompileOperationBlock(response.content);
  if (!parsed.ok) {
    throw new Error(`memory curate: ${parsed.reason}`);
  }
  if (parsed.operation.kind !== "rewrite_page") {
    throw new Error("memory curate: LLM must return rewrite_page");
  }
  return {
    ...parsed.operation,
    path: target,
  };
}

async function resolveCurateTarget(root: string, target: string | undefined): Promise<string> {
  const normalized = normalizeTarget(target);
  const fullPath = join(root, ...normalized.split("/"));
  if (existsSync(fullPath)) return normalized;

  const raw = target!.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (raw.includes("/")) {
    throw new Error(`memory curate: page not found: ${normalized}`);
  }

  const slug = raw.replace(/\.md$/i, "");
  const matches = await findPagesBySlug(root, slug);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `memory curate: target "${target}" is ambiguous; matches: ${matches.join(", ")}`,
    );
  }
  throw new Error(`memory curate: page not found: ${normalized}`);
}

function normalizeTarget(target: string | undefined): string {
  if (!target) throw new Error("memory curate: page target required unless --all is used");
  const normalized = target.replace(/\\/g, "/").replace(/^\.?\//, "");
  const withWiki = normalized.startsWith("wiki/") ? normalized : `wiki/${normalized}`;
  return withWiki.endsWith(".md") ? withWiki : `${withWiki}.md`;
}

async function findPagesBySlug(root: string, slug: string): Promise<string[]> {
  const wikiRoot = join(root, "wiki");
  if (!existsSync(wikiRoot)) return [];
  const matches: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const rel = relative(wikiRoot, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (rel.split("/").some((part) => part.startsWith(".") || part.endsWith("-proposed") || part === "archive")) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === `${slug.toLowerCase()}.md`) {
        matches.push(`wiki/${rel}`);
      }
    }
  }
  await walk(wikiRoot);
  return matches.sort();
}

async function listBloatedWikiPages(root: string, threshold: number): Promise<string[]> {
  const wikiRoot = join(root, "wiki");
  if (!existsSync(wikiRoot)) return [];
  const pages: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const rel = relative(wikiRoot, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (rel.split("/").some((part) => part.startsWith(".") || part.endsWith("-proposed") || part === "archive")) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readFile(fullPath, "utf-8");
        const body = parseFrontmatter(content).body;
        const sections = body.match(/^##\s+\d{4}-\d{2}-\d{2}/gm)?.length ?? 0;
        if (sections >= threshold) pages.push(`wiki/${rel}`);
      }
    }
  }

  await walk(wikiRoot);
  return pages.sort();
}
