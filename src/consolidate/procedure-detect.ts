import type { RelationMap } from "../retrieval/relations.js";

export interface RawProcedureObservationRef {
  relPath: string;
  created: string;
  relations?: RelationMap;
  session: string | null;
  source: string;
  title: string;
  body: string;
}

export interface CommandSignature {
  commands: string[];
  hasErrorIndicators: boolean;
}

export interface ProcedureCluster {
  observations: RawProcedureObservationRef[];
  signature: string[];
  distinctSessions: number;
  cohesionScore: number;
  hasSuccessfulOutcome: boolean;
}

export interface ProcedureDetectOptions {
  minClusterSize?: number;
  minDistinctSessions?: number;
  minSignatureLength?: number;
  minJaccard?: number;
}

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_MIN_DISTINCT_SESSIONS = 2;
const DEFAULT_MIN_SIGNATURE_LENGTH = 3;
const DEFAULT_MIN_JACCARD = 0.4;
const TRIVIAL_COMMANDS = new Set(["cd", "ls", "cat", "echo", "pwd"]);
const ERROR_PATTERNS = [
  /^error\b/im,
  /^fatal\b/im,
  /^fail\b/im,
  /exit code [1-9]/i,
  /Traceback/,
  /npm ERR!/i,
  /command failed/i,
];

interface ProcedureCandidate {
  observation: RawProcedureObservationRef;
  signature: CommandSignature;
}

export function extractCommandSignature(body: string): CommandSignature {
  const commands = extractCommandLines(body)
    .map(commandName)
    .filter((command): command is string => Boolean(command))
    .filter((command) => !TRIVIAL_COMMANDS.has(command));

  return {
    commands,
    hasErrorIndicators: ERROR_PATTERNS.some((pattern) => pattern.test(body)),
  };
}

export function detectProcedureClusters(
  observations: RawProcedureObservationRef[],
  opts: ProcedureDetectOptions = {},
): ProcedureCluster[] {
  const minClusterSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const minDistinctSessions = opts.minDistinctSessions ?? DEFAULT_MIN_DISTINCT_SESSIONS;
  const minSignatureLength = opts.minSignatureLength ?? DEFAULT_MIN_SIGNATURE_LENGTH;
  const minJaccard = opts.minJaccard ?? DEFAULT_MIN_JACCARD;

  const candidates = observations
    .map((observation): ProcedureCandidate => ({
      observation,
      signature: extractCommandSignature(observation.body),
    }))
    .filter((candidate) => candidate.signature.commands.length >= minSignatureLength)
    .sort((a, b) =>
      a.observation.created.localeCompare(b.observation.created) ||
      a.observation.relPath.localeCompare(b.observation.relPath)
    );

  const clusters: ProcedureCandidate[][] = [];
  for (const candidate of candidates) {
    const match = clusters.find((cluster) =>
      cluster.some((member) => signatureSimilarity(member.signature.commands, candidate.signature.commands) >= minJaccard)
    );
    if (match) {
      match.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }

  return clusters
    .map(toProcedureCluster)
    .filter((cluster) =>
      cluster.observations.length >= minClusterSize &&
      cluster.distinctSessions >= minDistinctSessions &&
      cluster.hasSuccessfulOutcome
    )
    .sort((a, b) =>
      b.cohesionScore * b.distinctSessions - a.cohesionScore * a.distinctSessions ||
      b.observations.length - a.observations.length ||
      a.observations[0]!.relPath.localeCompare(b.observations[0]!.relPath)
    );
}

function extractCommandLines(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const commands: string[] = [];
  let inFence = false;
  let fenceLanguage = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const fence = /^```([A-Za-z0-9_-]*)/.exec(line);
    if (fence) {
      if (inFence) {
        inFence = false;
        fenceLanguage = "";
      } else {
        inFence = true;
        fenceLanguage = (fence[1] ?? "").toLowerCase();
      }
      continue;
    }

    if (inFence && (fenceLanguage === "" || ["bash", "sh", "shell", "powershell", "ps1"].includes(fenceLanguage))) {
      commands.push(line);
      continue;
    }

    const prompt = /^(?:[$>]|PS [^>]+>)\s+(.+)$/.exec(line);
    if (prompt) {
      commands.push(prompt[1]!);
      continue;
    }

    const toolCall = /(?:command|cmd|args?)\s*[:=]\s*["']?([^"',\]}]+)/i.exec(line);
    if (toolCall) {
      commands.push(toolCall[1]!);
    }
  }

  return commands;
}

function commandName(line: string): string | null {
  const withoutComment = line.replace(/\s+#.*$/, "").trim();
  if (withoutComment.length === 0) return null;
  if (withoutComment.startsWith("#")) return null;
  const normalized = withoutComment
    .replace(/^(?:sudo|env|time)\s+/, "")
    .replace(/^&\s+/, "");
  const token = normalized.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "");
  if (!token) return null;
  const base = token.includes("\\") || token.includes("/")
    ? token.split(/[\\/]/).at(-1)!
    : token;
  return base.toLowerCase().replace(/\.(exe|cmd|ps1|sh)$/i, "");
}

function toProcedureCluster(candidates: ProcedureCandidate[]): ProcedureCluster {
  const observations = candidates.map((candidate) => candidate.observation);
  return {
    observations,
    signature: representativeSignature(candidates),
    distinctSessions: new Set(observations.map((observation) => observation.session ?? observation.relPath)).size,
    cohesionScore: round(meanPairwiseSimilarity(candidates), 3),
    hasSuccessfulOutcome: candidates.some((candidate) => !candidate.signature.hasErrorIndicators),
  };
}

function representativeSignature(candidates: ProcedureCandidate[]): string[] {
  return [...candidates]
    .sort((a, b) =>
      b.signature.commands.length - a.signature.commands.length ||
      a.observation.relPath.localeCompare(b.observation.relPath)
    )[0]!.signature.commands;
}

function meanPairwiseSimilarity(candidates: ProcedureCandidate[]): number {
  if (candidates.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      total += signatureSimilarity(candidates[i]!.signature.commands, candidates[j]!.signature.commands);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

function signatureSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
