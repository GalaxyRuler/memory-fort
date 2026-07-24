import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  confidenceAwareIndex,
  currentProjectMemoryBlock,
  whatToRememberBlock,
} from "./session-start-helpers.js";
import { memoryRoot } from "../storage/paths.js";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig } from "../storage/config.js";
import { readIndexGeneration, type IndexGeneration } from "../index/generation.js";

export interface SessionStartDeps {
  readFile?: (path: string) => Promise<string>;
  write?: (text: string) => void;
  memoryRoot?: string;
  maxInjectedChars?: number;
  detectTool?: typeof detectTool;
  configLoader?: (root: string) => Promise<MemoryConfig>;
  now?: () => Date;
}

const HEADER = `[memory:session-start] context loading\n`;
const TRUNCATION_SUFFIX = "\n[...truncated for budget]\n";

function readTotalInjectionBudget(): number {
  const raw = process.env["MEMORY_FORT_INJECTION_TOTAL_CHARS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : 12_000;
}

/**
 * Fill by ascending priority within one total budget (header + trim marker
 * included). A section that does not fit whole is truncated to the remaining
 * space rather than dropped, so a high-priority section always contributes
 * something. Sections are emitted in their original (display) order.
 */
export function applyInjectionBudget(
  sections: Array<{ label: string; text: string; priority: number }>,
  budget: number,
): string {
  const markerReserve = 120;
  let remaining = budget - HEADER.length - markerReserve;
  const rendered = new Map<number, string>();
  const trimmed: string[] = [];
  const byPriority = sections.map((section, index) => ({ ...section, index })).sort((a, b) => a.priority - b.priority);
  for (const section of byPriority) {
    if (section.text.length <= remaining) {
      rendered.set(section.index, section.text);
      remaining -= section.text.length;
    } else if (remaining > 200) {
      rendered.set(section.index, section.text.slice(0, remaining - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX);
      trimmed.push(section.label);
      remaining = 0;
    } else {
      trimmed.push(section.label);
    }
  }
  const body = sections.map((_, index) => rendered.get(index) ?? "").join("");
  const note = trimmed.length > 0 ? `[memory: trimmed ${trimmed.length} section(s): ${trimmed.join(", ")}]\n` : "";
  return `${HEADER}${body}${note}`;
}

/**
 * Phase 1 session-start: emit a plain text context block to
 * stdout containing schema.md + index.md + last 20 log.md lines.
 * Platform-specific output framing (JSON envelopes, structured
 * fields) deferred to Phase 2 if needed — Phase 1 plain text
 * works for Claude Code and Codex out of the box. Antigravity
 * live capture uses its own plugin hook scripts, so this shared
 * script never runs there.
 */
export async function sessionStartBody(
  payload: HookPayload,
  deps: SessionStartDeps = {},
): Promise<void> {
  const readFn =
    deps.readFile ??
    (async (p: string) => readFile(p, "utf-8"));
  const writeFn =
    deps.write ?? ((text: string) => process.stdout.write(text));
  const nowFn = deps.now ?? (() => new Date());
  const root = deps.memoryRoot ?? memoryRoot();

  if (await shouldSkipForDisabledClient(payload, deps)) return;

  const sections: Array<{ label: string; text: string; priority: number }> = [];
  const derivedGeneration = readyIndexGeneration(root);

  if (derivedGeneration) try {
    const projectBlock = await currentProjectMemoryBlock({
      cwd: readPayloadCwd(payload),
      memoryRoot: root,
      readFile: readFn,
      maxChars: deps.maxInjectedChars,
    });
    if (projectBlock && projectBlock.trim().length > 0) {
      sections.push({ label: "project", text: `\n${projectBlock.trim()}\n`, priority: 1 });
    }
  } catch {
    // Project memory is opportunistic; preserve the legacy schema/index/log output.
  }

  const fileSections: Array<{
    label: string;
    path: string;
    tail?: number;
    confidenceAware?: boolean;
    priority: number;
  }> = [
    { label: "Schema", path: join(root, "schema.md"), priority: 4 },
    ...(derivedGeneration
      ? [{ label: "Index", path: join(root, "index.md"), confidenceAware: true, priority: 2 }]
      : []),
    { label: "Recent log", path: join(root, "log.md"), tail: 20, priority: 5 },
  ];

  for (const sec of fileSections) {
    try {
      const content = sec.confidenceAware
        ? await confidenceAwareIndex({ indexFilePath: sec.path, memoryRoot: root, readFile: readFn })
        : await readFn(sec.path);
      if (sec.confidenceAware && content.trim().length === 0) continue;
      const body = sec.tail ? lastLines(content, sec.tail) : content;
      sections.push({ label: sec.label, text: `\n--- ${sec.label} (${sec.path}) ---\n${body.trim()}\n`, priority: sec.priority });
    } catch {
      // Missing file is normal on fresh installs; skip silently
    }
  }

  if (derivedGeneration) {
    const remember = await whatToRememberBlock({ memoryRoot: root, readFile: readFn, now: nowFn() });
    if (remember.trim().length > 0) {
      sections.push({ label: "remember", text: `\n${remember}`, priority: 3 });
    }
  }

  const safeSections = derivedGeneration && !sameReadyIndexGeneration(root, derivedGeneration)
    ? sections.filter((section) =>
      section.label !== "project" && section.label !== "Index" && section.label !== "remember"
    )
    : sections;
  writeFn(applyInjectionBudget(safeSections, readTotalInjectionBudget()));
}

function readyIndexGeneration(root: string): IndexGeneration | null {
  try {
    const generation = readIndexGeneration(root);
    return generation.state === "ready" ? generation : null;
  } catch {
    return null;
  }
}

function sameReadyIndexGeneration(root: string, expected: IndexGeneration): boolean {
  const current = readyIndexGeneration(root);
  return current !== null && current.token === expected.token;
}

async function shouldSkipForDisabledClient(
  payload: HookPayload,
  deps: SessionStartDeps,
): Promise<boolean> {
  const shouldReadConfig = deps.configLoader !== undefined ||
    (deps.readFile === undefined && deps.write === undefined);
  if (!shouldReadConfig) return false;
  const root = deps.memoryRoot ?? memoryRoot();
  const config = await (deps.configLoader ?? loadMemoryConfig)(root);
  const tool = (deps.detectTool ?? detectTool)({ payload });
  return !isClientEnabled(config, tool);
}

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function readPayloadCwd(payload: HookPayload): string | null {
  if (typeof payload.cwd === "string" && payload.cwd.trim().length > 0) return payload.cwd;
  if (
    typeof payload.working_directory === "string" &&
    payload.working_directory.trim().length > 0
  ) {
    return payload.working_directory;
  }
  return null;
}

if (process.argv[1]?.endsWith("session-start.mjs")) {
  runHook({ hookName: "session-start", body: sessionStartBody });
}
