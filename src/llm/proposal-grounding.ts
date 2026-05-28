import { stat } from "node:fs/promises";
import { join, normalize } from "node:path";

export interface ProposalCandidates {
  wikiPagePaths: string[];
  candidateRationale: string;
}

export interface ProposalGroundingStats {
  originalReferenceCount: number;
  strippedReferenceCount: number;
  stripReasons: string[];
  strippedSamples: string[];
}

export interface ProposalObservation {
  relPath: string;
  relations?: Record<string, Array<{ target: string }>>;
  entities?: string[];
}

export interface FilterResult<T> {
  filtered: T[];
  stripped: T[];
}

export const MEMORY_CLI_SUBCOMMANDS = [
  "backfill",
  "backfill-source",
  "compile",
  "connect",
  "consolidate",
  "doctor",
  "grep",
  "import-agentmemory",
  "init",
  "install",
  "install-tailscale-route",
  "install-vps",
  "lint",
  "log",
  "page",
  "procedure",
  "provider",
  "prune",
  "pull",
  "push",
  "rewrite-imported-timestamps",
  "search",
  "stats",
  "sync",
  "sync-bootstrap",
  "tail-errors",
  "thread",
  "verify",
  "watch",
] as const;

const MAX_CANDIDATES = 50;
const ALLOWED_SHELL_COMMANDS = new Set(["git", "npm", "ssh", "scp", "curl", "cd", "ls", "cat"]);
const MEMORY_SUBCOMMAND_SET = new Set<string>(MEMORY_CLI_SUBCOMMANDS);

export async function extractProposalCandidates(opts: {
  vaultRoot: string;
  observations: ProposalObservation[];
}): Promise<ProposalCandidates> {
  const counts = new Map<string, number>();
  for (const observation of opts.observations) {
    for (const target of observationTargets(observation)) {
      if (!isWikiMarkdownPath(target)) continue;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }

  const existing: Array<{ path: string; count: number }> = [];
  for (const [path, count] of counts) {
    if (await vaultPathExists(opts.vaultRoot, path)) {
      existing.push({ path, count });
    }
  }

  const selected = existing
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, MAX_CANDIDATES)
    .map((item) => item.path)
    .sort((a, b) => a.localeCompare(b));

  return {
    wikiPagePaths: selected,
    candidateRationale: `${selected.length} existing wiki pages referenced by this cluster`,
  };
}

export async function filterWikiReferencesToExisting(
  vaultRoot: string,
  relationPaths: string[],
): Promise<FilterResult<string>> {
  const filtered: string[] = [];
  const stripped: string[] = [];
  for (const relationPath of relationPaths) {
    if (relationPath.startsWith("wiki/")) {
      if (isWikiMarkdownPath(relationPath) && await vaultPathExists(vaultRoot, relationPath)) {
        filtered.push(relationPath);
      } else {
        stripped.push(relationPath);
      }
      continue;
    }
    if (relationPath.startsWith("raw/")) {
      if (await vaultPathExists(vaultRoot, relationPath)) {
        filtered.push(relationPath);
      } else {
        stripped.push(relationPath);
      }
      continue;
    }
    filtered.push(relationPath);
  }
  return { filtered, stripped };
}

export function filterStepCommands<T extends { command?: string; description: string }>(
  steps: T[],
): { steps: T[]; stripped: string[] } {
  const stripped: string[] = [];
  const filtered = steps.map((step) => {
    if (!step.command) return step;
    if (isAllowedCommand(step.command)) return step;
    stripped.push(step.command);
    const { command: _command, ...withoutCommand } = step;
    return withoutCommand as T;
  });
  return { steps: filtered, stripped };
}

export function emptyGroundingStats(): ProposalGroundingStats {
  return {
    originalReferenceCount: 0,
    strippedReferenceCount: 0,
    stripReasons: [],
    strippedSamples: [],
  };
}

export function groundingStatsFromStripped(input: {
  originalReferenceCount: number;
  stripped: string[];
  reason: string;
}): ProposalGroundingStats {
  return {
    originalReferenceCount: input.originalReferenceCount,
    strippedReferenceCount: input.stripped.length,
    stripReasons: input.stripped.map((item) => `${input.reason}: ${item}`),
    strippedSamples: input.stripped.slice(0, 3),
  };
}

export function formatCandidateList(candidates: ProposalCandidates): string {
  return candidates.wikiPagePaths.length > 0
    ? candidates.wikiPagePaths.map((path) => `- ${path}`).join("\n")
    : "- none";
}

export function formatMemoryCliList(): string {
  return MEMORY_CLI_SUBCOMMANDS.map((command) => `- memory ${command}`).join("\n");
}

function observationTargets(observation: ProposalObservation): string[] {
  const fromRelations = Object.values(observation.relations ?? {})
    .flatMap((edges) => edges.map((edge) => edge.target));
  return [...fromRelations, ...(observation.entities ?? [])];
}

function isAllowedCommand(command: string): boolean {
  const normalized = command.trim();
  if (normalized.length === 0) return false;
  const [name, subcommand] = normalized.split(/\s+/);
  if (name === "memory") {
    return Boolean(subcommand && MEMORY_SUBCOMMAND_SET.has(subcommand));
  }
  return Boolean(name && ALLOWED_SHELL_COMMANDS.has(name));
}

function isWikiMarkdownPath(value: string): boolean {
  return value.startsWith("wiki/") && value.endsWith(".md") && !value.includes("..");
}

async function vaultPathExists(vaultRoot: string, relPath: string): Promise<boolean> {
  if (relPath.includes("..")) return false;
  const fullPath = join(vaultRoot, ...normalize(relPath).split(/[\\/]+/));
  try {
    const info = await stat(fullPath);
    return info.isFile();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
