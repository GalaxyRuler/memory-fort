import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { atomicWrite } from "../../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot } from "../../storage/paths.js";
import { hasArchiveOrSystemPathComponent } from "../../storage/archive-paths.js";
import { createLLMFromConfig, getActiveLLMConfig, type LLMConfig } from "../../llm/factory.js";
import type { LLMProvider } from "../../llm/types.js";
import { loadMemoryConfig, resolveCompileConfig, type MemoryConfig } from "../../storage/config.js";
import {
  archivePageVersion,
  isNarrativeKnowledgePagePath,
  NARRATIVE_SYNTHESIS_SYSTEM_PROMPT,
  nextNarrativeFrontmatter,
  stageNarrativeReview,
  validateNarrativeBody,
  validateDatedBlockConservation,
  validateWikilinkRetention,
} from "../../compile/synthesize-narrative.js";
import { assessClaimSupport } from "../../compile/faithfulness.js";

export type MigrateToNarrativeMode = "plan" | "apply";

export interface MigrateToNarrativeOptions {
  vaultRoot?: string;
  mode: MigrateToNarrativeMode;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  configLoader?: () => Promise<MemoryConfig>;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
}

export interface MigrateToNarrativeResult {
  mode: MigrateToNarrativeMode;
  candidates: string[];
  migrated: string[];
  staged: string[];
  unchanged: string[];
  report: string;
}

const MIGRATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: { type: "string" },
  },
};

export async function runMigrateToNarrative(opts: MigrateToNarrativeOptions): Promise<MigrateToNarrativeResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const now = opts.now ?? new Date();
  const candidates = await listMigrationCandidates(root);
  const migrated: string[] = [];
  const staged: string[] = [];
  const unchanged: string[] = [];

  if (opts.mode === "apply" && candidates.length > 0) {
    const env = opts.env ?? process.env;
    const config = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
    const llmConfig = getActiveLLMConfig(config);
    const llm = (opts.llmFactory ?? createLLMFromConfig)(llmConfig, env);
    const faithfulnessCheck = resolveCompileConfig(config.compile).faithfulness_check;

    for (const relPath of candidates) {
      const result = await migrateOne(root, relPath, llm, now, faithfulnessCheck);
      if (result === "migrated") migrated.push(relPath);
      if (result === "unchanged") unchanged.push(relPath);
      if (result === "staged") staged.push(relPath);
    }
  }

  return {
    mode: opts.mode,
    candidates,
    migrated,
    staged,
    unchanged,
    report: formatMigrateReport(opts.mode, candidates, migrated, staged, unchanged),
  };
}

async function migrateOne(
  root: string,
  relPath: string,
  llm: LLMProvider,
  now: Date,
  faithfulnessCheck: boolean,
): Promise<"migrated" | "staged" | "unchanged"> {
  const fullPath = join(root, ...relPath.split("/"));
  const current = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(current);
  const flattened = flattenBody(parsed.body);
  let body: string;
  try {
    const response = await llm.chat({
      messages: [
        {
          role: "system",
          content: NARRATIVE_SYNTHESIS_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            "Convert this existing knowledge page body into one coherent narrative body using the synthesis rules.",
            `Path: ${relPath}`,
            "",
            "Frontmatter:",
            JSON.stringify(parsed.frontmatter, null, 2),
            "",
            "CURRENT BODY:",
            parsed.body.trim(),
            "",
            "contradicted_claims:",
            "[]",
            "",
            "net_new_facts:",
            flattened
              .split(/\n+/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .map((line) => `- ${line}`)
              .join("\n"),
          ].join("\n"),
        },
      ],
      temperature: 0.2,
      jsonSchema: { name: "NarrativeMigrationOutput", schema: MIGRATE_SCHEMA, strict: true },
    });
    if (response.finishReason !== "stop") {
      throw new Error(`migration response finishReason=${response.finishReason}`);
    }
    body = parseBody(response.content);
  } catch (error) {
    await stageNarrativeReview(root, relPath, {
      reason: `migration response unverifiable: ${errorMessage(error)}`,
      body: parsed.body,
    }, now);
    return "staged";
  }
  const validation = validateNarrativeBody(body);
  const shrinkRatio = body.length / Math.max(1, parsed.body.trim().length);
  const missingLinks = existingWikilinks(parsed.body).filter((link) => !body.includes(link));
  const wikilinkCheck = validateWikilinkRetention(parsed.body, body);
  const datedCheck = validateDatedBlockConservation(parsed.body, body, []);
  if (!validation.ok || shrinkRatio < 0.3 || !wikilinkCheck.ok || !datedCheck.ok || missingLinks.length > 0) {
    await stageNarrativeReview(root, relPath, {
      reason: validation.ok ? "migration safety gate failed" : validation.reason,
      shrinkRatio,
      missingLinks,
      body,
    }, now);
    return "staged";
  }
  if (await readFile(fullPath, "utf-8") !== current) {
    await stageNarrativeReview(root, relPath, { reason: "migration source changed before verification", body }, now);
    return "staged";
  }
  if (faithfulnessCheck !== false) {
    const verdict = await assessClaimSupport({ body, facts: [], priorBody: parsed.body, llm });
    if (verdict.outcome !== "supported") {
      await stageNarrativeReview(root, relPath, {
        reason: verdict.outcome === "unsupported"
          ? `migration unsupported claims: ${verdict.unsupportedClaims.join("; ")}`
          : "migration faithfulness check unverifiable",
        body,
      }, now);
      return "staged";
    }
  } else {
    console.warn(`memory migrate-to-narrative: unverified generation enabled for ${relPath}; this advanced local opt-out can write without a faithfulness verdict`);
  }
  if (body.trim() === parsed.body.trim()) return "unchanged";
  if (await readFile(fullPath, "utf-8") !== current) {
    await stageNarrativeReview(root, relPath, { reason: "migration source changed before write", body }, now);
    return "staged";
  }
  const history = await archivePageVersion(root, relPath, current, now, parsed.frontmatter);
  await mkdir(dirname(fullPath), { recursive: true });
  await atomicWrite(fullPath, serializeFrontmatter(nextNarrativeFrontmatter(parsed.frontmatter, now, [], history), `${body.trim()}\n`));
  return "migrated";
}

async function listMigrationCandidates(root: string): Promise<string[]> {
  const wikiRoot = join(root, "wiki");
  if (!existsSync(wikiRoot)) return [];
  const candidates: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const rel = relative(wikiRoot, fullPath).replace(/\\/g, "/");
      const relPath = `wiki/${rel}`;
      if (hasArchiveOrSystemPathComponent(relPath)) continue;
      if (entry.isDirectory()) {
        if (rel.split("/").some((part) => part.toLowerCase().endsWith("-proposed"))) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (!isNarrativeKnowledgePagePath(relPath)) continue;
        const body = parseFrontmatter(await readFile(fullPath, "utf-8")).body;
        if (!validateNarrativeBody(body).ok) candidates.push(relPath);
      }
    }
  }
  await walk(wikiRoot);
  return candidates.sort();
}

function formatMigrateReport(
  mode: MigrateToNarrativeMode,
  candidates: string[],
  migrated: string[],
  staged: string[],
  unchanged: string[],
): string {
  const lines = [`Migrate to narrative ${mode}`];
  lines.push(`Candidates: ${candidates.length}`);
  for (const candidate of candidates) lines.push(`- ${candidate}`);
  if (mode === "apply") {
    lines.push(`Migrated: ${migrated.length}`);
    lines.push(`Staged: ${staged.length}`);
    lines.push(`Unchanged: ${unchanged.length}`);
  }
  return `${lines.join("\n")}\n`;
}

function flattenBody(body: string): string {
  return body
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*\d+\.\s+/gmu, "")
    .replace(/```[\s\S]*?```/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function parseBody(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/mu.exec(content)?.[1]?.trim();
  const raw = fenced ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  const parsed = JSON.parse(raw) as { body?: unknown };
  if (typeof parsed.body !== "string" || parsed.body.trim().length === 0) {
    throw new Error("migrate-to-narrative: LLM returned no body");
  }
  return parsed.body.trim();
}

function existingWikilinks(body: string): string[] {
  return Array.from(body.matchAll(/\[\[[^\]]+\]\]/gu)).map((match) => match[0]!);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
