import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { atomicWrite } from "../../storage/atomic-write.js";
import { detectTemplateVars, type TemplateVars } from "../template-render.js";
import { runConnect, type ConnectOptions, type ConnectResult } from "./connect.js";
import { runInit, type InitOptions, type InitResult } from "./init.js";
import { type CommandStdout } from "./write-guard.js";

export const INIT_TOOL_NAMES = [
  "claude-code",
  "claude-desktop",
  "codex",
  "antigravity",
  "vscode",
] as const;

export type InitToolName = typeof INIT_TOOL_NAMES[number];
export type RetrievalMode = "lexical" | "voyage" | "openai" | "ollama";
export type QuestionPrompt = (question: string) => Promise<string>;

export interface CommandStdin {
  isTTY?: boolean;
}

export interface InitOnboardingOptions extends Pick<InitOptions, "reset" | "sourceRepoDir" | "now" | "dryRun" | "yes"> {
  vault?: string;
  name?: string;
  tools?: string;
  retrieval?: string;
  stdout?: CommandStdout;
  stdin?: CommandStdin;
  prompt?: QuestionPrompt;
  connectFn?: (opts: ConnectOptions) => Promise<ConnectResult>;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fs?: ExistsFs;
}

export interface InitOnboardingResult {
  init: InitResult;
  vault: string;
  name: string;
  tools: InitToolName[];
  retrieval: RetrievalMode;
  connect: ConnectResult[];
}

export interface DetectInitToolsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fs?: ExistsFs;
}

export interface ExistsFs {
  existsSync(path: string): boolean;
}

const RETRIEVAL_DEFAULTS: Record<RetrievalMode, { model: string; dim: number }> = {
  lexical: { model: "lexical", dim: 0 },
  voyage: { model: "voyage-4-large", dim: 1024 },
  openai: { model: "text-embedding-3-small", dim: 1536 },
  ollama: { model: "nomic-embed-text", dim: 0 },
};

export async function runInitOnboarding(
  opts: InitOnboardingOptions = {},
): Promise<InitOnboardingResult> {
  const stdout = opts.stdout ?? processStdout;
  const input = opts.stdin ?? processStdin;
  const homeDir = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;
  const templateVars = detectTemplateVars({
    sourceRepoDir: opts.sourceRepoDir,
    now: opts.now,
  });
  const detectedTools = detectInitTools({
    homeDir,
    env,
    platform: opts.platform,
    fs: opts.fs,
  });
  const interactive =
    input.isTTY === true &&
    stdout.isTTY === true &&
    opts.yes !== true &&
    opts.dryRun !== true;

  if (interactive) {
    const answers = await askInitWizard({
      prompt: opts.prompt,
      stdout,
      homeDir,
      detectedTools,
      templateVars,
    });
    return executeOnboarding({
      ...opts,
      vault: answers.vault,
      name: answers.name,
      selectedTools: answers.tools,
      retrieval: answers.retrieval,
      templateVars,
    });
  }

  if (opts.yes === true) {
    const selectedTools = parseInitTools(opts.tools, detectedTools);
    return executeOnboarding({
      ...opts,
      vault: resolveVaultRoot({ vault: opts.vault, env, homeDir }),
      name: opts.name ?? templateVars.user_name,
      selectedTools,
      retrieval: parseRetrievalMode(opts.retrieval),
      templateVars,
    });
  }

  const retrieval = parseRetrievalMode(opts.retrieval);
  if (opts.name !== undefined || opts.tools !== undefined || opts.retrieval !== undefined) {
    const selectedTools = opts.tools === undefined ? [] : parseInitTools(opts.tools, detectedTools);
    return executeOnboarding({
      ...opts,
      vault: resolveVaultRoot({ vault: opts.vault, env, homeDir }),
      name: opts.name ?? templateVars.user_name,
      selectedTools,
      retrieval,
      templateVars,
    });
  }

  const vault = opts.vault ? expandHome(opts.vault, homeDir) : resolveVaultRoot({ env, homeDir });
  const init = await runInit({
    reset: opts.reset,
    sourceRepoDir: opts.sourceRepoDir,
    now: opts.now,
    dryRun: opts.dryRun,
    yes: true,
    stdout,
    vault,
  });
  if (!init.dryRun && opts.retrieval) {
    await writeRetrievalMode(init.root, retrieval);
  }
  return {
    init,
    vault: init.root,
    name: opts.name ?? templateVars.user_name,
    tools: [],
    retrieval,
    connect: [],
  };
}

export function detectInitTools(opts: DetectInitToolsOptions = {}): InitToolName[] {
  const fs = opts.fs ?? { existsSync };
  const homeDir = opts.homeDir ?? homedir();
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const detected: InitToolName[] = [];

  if (fs.existsSync(join(homeDir, ".claude"))) detected.push("claude-code");
  if (fs.existsSync(claudeDesktopConfigPathFor({ homeDir, env, platform }))) {
    detected.push("claude-desktop");
  }
  if (fs.existsSync(join(homeDir, ".codex"))) detected.push("codex");
  if (fs.existsSync(join(homeDir, ".gemini", "antigravity"))) {
    detected.push("antigravity");
  }
  if (fs.existsSync(vscodeUserDirFor({ homeDir, env, platform }))) detected.push("vscode");

  return detected;
}

export function parseInitTools(input: string | undefined, detected: InitToolName[]): InitToolName[] {
  const raw = input?.trim();
  if (!raw) return detected;
  if (raw.toLowerCase() === "none") return [];
  if (raw.toLowerCase() === "all") return detected;

  const selected = raw.split(",")
    .map((tool) => tool.trim().toLowerCase())
    .filter(Boolean);
  const invalid = selected.filter((tool) => !isInitTool(tool));
  if (invalid.length > 0) {
    throw new Error(`unsupported tool(s): ${invalid.join(", ")}`);
  }
  return [...new Set(selected)] as InitToolName[];
}

export function parseRetrievalMode(input: string | undefined): RetrievalMode {
  const raw = input?.trim().toLowerCase();
  if (!raw) return "lexical";
  if (raw === "lexical" || raw === "keyless") return "lexical";
  if (raw === "voyage" || raw === "openai" || raw === "ollama") return raw;
  throw new Error("retrieval must be lexical, voyage, openai, or ollama");
}

export async function writeRetrievalMode(root: string, mode: RetrievalMode): Promise<void> {
  const path = join(root, "config.yaml");
  const config = await readFile(path, "utf-8");
  const defaults = RETRIEVAL_DEFAULTS[mode];
  const next = upsertYamlSectionFields(
    upsertYamlSectionFields(config, "embedder", {
      provider: mode,
      model: defaults.model,
    }),
    "embedding",
    {
      provider: mode,
      model: defaults.model,
      dim: String(defaults.dim),
    },
  );
  await atomicWrite(path, next.endsWith("\n") ? next : `${next}\n`);
}

async function executeOnboarding(args: InitOnboardingOptions & {
  selectedTools: InitToolName[];
  retrieval: RetrievalMode;
  templateVars: TemplateVars;
}): Promise<InitOnboardingResult> {
  const vault = resolveVaultRoot({
    vault: args.vault,
    env: args.env ?? process.env,
    homeDir: args.homeDir,
  });
  const connectFn = args.connectFn ?? runConnect;
  const name = args.name?.trim() || args.templateVars.user_name;
  const initTemplateVars = { ...args.templateVars, user_name: name };

  return withMemoryRoot(vault, async () => {
    const init = await runInit({
      reset: args.reset,
      sourceRepoDir: args.sourceRepoDir,
      now: args.now,
      dryRun: args.dryRun,
      yes: true,
      stdout: args.stdout,
      templateVars: initTemplateVars,
    });
    if (init.dryRun || init.cancelled) {
      return {
        init,
        vault,
        name,
        tools: args.selectedTools,
        retrieval: args.retrieval,
        connect: [],
      };
    }

    await writeRetrievalMode(vault, args.retrieval);
    const connect: ConnectResult[] = [];
    for (const tool of args.selectedTools) {
      connect.push(await connectFn({
        client: tool,
        noVerify: true,
        yes: true,
        stdout: args.stdout,
      }));
    }

    return {
      init,
      vault,
      name,
      tools: args.selectedTools,
      retrieval: args.retrieval,
      connect,
    };
  });
}

async function askInitWizard(args: {
  prompt?: QuestionPrompt;
  stdout: CommandStdout;
  homeDir: string;
  detectedTools: InitToolName[];
  templateVars: TemplateVars;
}): Promise<{
  vault: string;
  name: string;
  tools: InitToolName[];
  retrieval: RetrievalMode;
}> {
  const prompt = args.prompt ?? defaultQuestionPrompt;
  const toolsDefault = args.detectedTools.length > 0
    ? args.detectedTools.join(",")
    : "none";
  const vaultAnswer = await prompt("Vault location [~/.memory] ");
  const nameAnswer = await prompt(`Your name [${args.templateVars.user_name}] `);
  const toolsAnswer = await prompt(`Tools to wire [${toolsDefault}] `);
  const retrievalAnswer = await prompt(
    "Retrieval mode [lexical (keyless) | voyage | openai | ollama] ",
  );

  return {
    vault: expandHome(vaultAnswer.trim() || "~/.memory", args.homeDir),
    name: nameAnswer.trim() || args.templateVars.user_name,
    tools: parseInitTools(toolsAnswer, args.detectedTools),
    retrieval: parseRetrievalMode(retrievalAnswer),
  };
}

function upsertYamlSectionFields(
  input: string,
  section: string,
  fields: Record<string, string>,
): string {
  const lines = input.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === `${section}:`);
  if (sectionIndex < 0) {
    const prefix = input.endsWith("\n") ? input : `${input}\n`;
    return `${prefix}\n${section}:\n${renderYamlFields(fields)}`;
  }

  let end = sectionIndex + 1;
  while (
    end < lines.length &&
    (
      lines[end]!.trim().length === 0 ||
      lines[end]!.startsWith(" ") ||
      lines[end]!.startsWith("\t") ||
      lines[end]!.trim().startsWith("#")
    )
  ) {
    end += 1;
  }

  const block = lines.slice(sectionIndex + 1, end);
  for (const [key, value] of Object.entries(fields)) {
    const existingIndex = block.findIndex((line) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`).test(line));
    const nextLine = `  ${key}: ${value}`;
    if (existingIndex >= 0) {
      block[existingIndex] = nextLine;
    } else {
      block.push(nextLine);
    }
  }

  return [
    ...lines.slice(0, sectionIndex + 1),
    ...block,
    ...lines.slice(end),
  ].join("\n");
}

function renderYamlFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n") + "\n";
}

function claudeDesktopConfigPathFor(opts: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): string {
  const override = opts.env["MEMORY_CLAUDE_DESKTOP_DIR"];
  if (override && override.trim().length > 0) return join(override, "claude_desktop_config.json");
  if (opts.platform === "win32" && opts.env["APPDATA"]) {
    return join(opts.env["APPDATA"], "Claude", "claude_desktop_config.json");
  }
  return join(opts.homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

function vscodeUserDirFor(opts: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): string {
  const override = opts.env["MEMORY_VSCODE_USER_DIR"];
  if (override && override.trim().length > 0) return override;
  if (opts.platform === "win32") {
    return join(opts.env["APPDATA"] ?? join(opts.homeDir, "AppData", "Roaming"), "Code", "User");
  }
  if (opts.platform === "darwin") {
    return join(opts.homeDir, "Library", "Application Support", "Code", "User");
  }
  return join(opts.homeDir, ".config", "Code", "User");
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homeDir, path.slice(2));
  return path;
}

function resolveVaultRoot(opts: {
  vault?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const homeDir = opts.homeDir ?? homedir();
  const envRoot = opts.env?.["MEMORY_ROOT"];
  return expandHome(
    opts.vault ?? (envRoot && envRoot.trim().length > 0 ? envRoot : "~/.memory"),
    homeDir,
  );
}

async function defaultQuestionPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: processStdin, output: processStdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function withMemoryRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env["MEMORY_ROOT"];
  process.env["MEMORY_ROOT"] = root;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = before;
  }
}

function isInitTool(value: string): value is InitToolName {
  return (INIT_TOOL_NAMES as readonly string[]).includes(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
