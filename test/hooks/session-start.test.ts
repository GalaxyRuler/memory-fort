import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confidenceAwareIndex,
  currentProjectMemoryBlock,
  resolveProjectForCwd,
  whatToRememberBlock,
} from "../../src/hooks/session-start-helpers.js";
import { applyInjectionBudget, sessionStartBody } from "../../src/hooks/session-start.js";

describe("applyInjectionBudget", () => {
  it("keeps total output within the budget including the trim marker", () => {
    const sections = [
      { label: "project", text: "P".repeat(50_000), priority: 1 },
      { label: "Index", text: "I".repeat(50_000), priority: 2 },
    ];
    const out = applyInjectionBudget(sections, 5_000);
    expect(out.length).toBeLessThanOrEqual(5_000);
  });

  it("truncates an oversized high-priority section instead of dropping it wholesale", () => {
    const sections = [
      { label: "project", text: `\nPROJECT_MARKER ${"x".repeat(50_000)}`, priority: 1 },
      { label: "Recent log", text: "\nlog tail", priority: 5 },
    ];
    const out = applyInjectionBudget(sections, 5_000);
    expect(out).toContain("PROJECT_MARKER"); // survived, truncated
    expect(out).toContain("[...truncated for budget]");
    expect(out).toContain("[memory: trimmed");
  });

  it("emits all sections whole when they fit", () => {
    const out = applyInjectionBudget([{ label: "a", text: "short", priority: 1 }], 12_000);
    expect(out).toContain("short");
    expect(out).not.toContain("trimmed");
  });
});

describe("sessionStartBody", () => {
  let tmp: string;
  let oldMemoryRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "session-start-"));
    oldMemoryRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (oldMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = oldMemoryRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("never reads outside a custom memoryRoot (index confidence lookups included)", async () => {
    const customRoot = await mkdtemp(join(tmpdir(), "session-start-custom-"));
    try {
      await mkdir(join(customRoot, "wiki", "projects"), { recursive: true });
      await writeFile(join(customRoot, "index.md"), "- [item](wiki/projects/item.md) — a linked page\n");
      await writeFile(
        join(customRoot, "wiki", "projects", "item.md"),
        `---\ntype: projects\ntitle: item\nconfidence: 0.95\n---\n\nCustom vault page.\n`,
      );
      const readPaths: string[] = [];
      await sessionStartBody({}, {
        memoryRoot: customRoot,
        readFile: async (p: string) => {
          readPaths.push(p);
          return (await import("node:fs/promises")).readFile(p, "utf-8");
        },
        write: () => undefined,
        now: () => new Date("2026-07-18T00:00:00.000Z"),
      });
      // MEMORY_ROOT (the "default" vault, `tmp`) must never be touched when a
      // custom root is injected — confidence lookups for index-linked pages
      // previously fell back to the default vault.
      expect(readPaths.length).toBeGreaterThan(0);
      expect(readPaths.filter((p) => p.startsWith(tmp))).toEqual([]);
    } finally {
      await rm(customRoot, { recursive: true, force: true });
    }
  });

  it("emits schema + index + log sections when all present", async () => {
    const writes: string[] = [];
    await sessionStartBody(
      {},
      {
        readFile: async (path) => {
          if (path.endsWith("schema.md")) return "schema content";
          if (path.endsWith("index.md")) return "index content";
          if (path.endsWith("log.md")) return "line1\nline2\nline3";
          throw new Error("ENOENT");
        },
        write: (t) => writes.push(t),
      },
    );
    const all = writes.join("");
    expect(all).toContain("schema content");
    expect(all).toContain("--- Medium-confidence entries (1) ---");
    expect(all).toContain("index content");
    expect(all).toContain("line1");
  });

  it("skips missing files silently", async () => {
    const writes: string[] = [];
    await sessionStartBody(
      {},
      {
        readFile: async () => {
          throw new Error("ENOENT");
        },
        write: (t) => writes.push(t),
      },
    );
    const all = writes.join("");
    expect(all).toContain("[memory:session-start]");
    expect(all).not.toContain("Schema");
  });

  it("emits no session context when the detected client is disabled", async () => {
    const writes: string[] = [];
    await sessionStartBody(
      {},
      {
        detectTool: () => "codex",
        configLoader: async () => ({ clients: { codex: false } }),
        readFile: async () => "should not be read",
        write: (t) => writes.push(t),
      },
    );

    expect(writes).toEqual([]);
  });

  it("tails log.md to last 20 lines", async () => {
    const writes: string[] = [];
    const longLog = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    await sessionStartBody(
      {},
      {
        readFile: async (path) => {
          if (path.endsWith("log.md")) return longLog;
          throw new Error("ENOENT");
        },
        write: (t) => writes.push(t),
      },
    );
    const all = writes.join("");
    expect(all).not.toContain("line0");
    expect(all).toContain("line49");
  });

  it("emits confidence-bucketed index output", async () => {
    const writes: string[] = [];
    await sessionStartBody(
      {},
      {
        readFile: makeConfidenceReadFile(),
        write: (t) => writes.push(t),
      },
    );

    const all = writes.join("");
    expect(all).toContain("--- High-confidence entries (1) ---");
    expect(all).toContain("- [[projects/high]] High");
    expect(all).toContain("--- Medium-confidence entries (1) ---");
    expect(all).toContain("- [[projects/medium]] Medium");
    expect(all).toContain("--- Low-confidence / drafts (1) ---");
    expect(all).toContain("⚠ DRAFT: - [[projects/low]] Low");
  });

  it("injects preferences page, preference-tagged observations, and recent high-confidence observations", async () => {
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-28"), { recursive: true });
    await writeFile(join(tmp, "schema.md"), "schema content");
    await writeFile(join(tmp, "index.md"), "# Index\n\nNo curated pages yet.\n");
    await writeFile(join(tmp, "log.md"), "line1\nline2");
    await writeFile(
      join(tmp, "wiki", "preferences.md"),
      [
        "---",
        "type: references",
        "title: Operator Preferences",
        "tags: [preference]",
        "confidence: 0.95",
        "---",
        "Always draft Codex prompts before handing them off.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(tmp, "raw", "2026-05-28", "manual-session.md"),
      [
        "---",
        "type: raw-session",
        "title: manual session",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "---",
        "",
        "## [08:00:00] Observation",
        "",
        "_tags: preference, codex · confidence: 0.91_",
        "",
        "Emit paths in code blocks when preparing handoff prompts.",
        "",
        "## [09:00:00] Observation",
        "",
        "_tags: project · confidence: 0.88_",
        "",
        "Memory Fort should feed recent salient observations back at session start.",
        "",
        "## [10:00:00] Observation",
        "",
        "_tags: noise · confidence: 0.2_",
        "",
        "Low confidence noise should stay out of the injected reminder block.",
        "",
      ].join("\n"),
    );

    const writes: string[] = [];
    await sessionStartBody({}, {
      write: (text) => writes.push(text),
      now: () => new Date("2026-05-29T00:00:00.000Z"),
    });

    const all = writes.join("");
    expect(all).toContain("--- What you should remember");
    expect(all).toContain("Always draft Codex prompts");
    expect(all).toContain("Emit paths in code blocks");
    expect(all).toContain("Memory Fort should feed recent salient observations");
    expect(all).not.toContain("Low confidence noise");
  });

  it("injects current project memory and related summaries before the global index", async () => {
    await writeSessionStartFiles(tmp);
    await writeProjectPage(
      tmp,
      "memory-system",
      [
        "Memory-system keeps cross-agent memory useful at session start.",
        "",
        "The current narrative body should be injected in full. It links to [[session-start-memory]].",
      ].join("\n"),
      {
        relations: [
          "relations:",
          "  linked:",
          "    - wiki/projects/agentmemory.md",
        ],
      },
    );
    await writeProjectPage(
      tmp,
      "agentmemory",
      "AgentMemory is an older name for this memory system.",
      { title: "AgentMemory", updated: "2026-05-30", strength: 0.9 },
    );
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "lessons", "session-start-memory.md"),
      [
        "---",
        "type: lessons",
        "title: Session Start Memory",
        "created: 2026-05-30",
        "updated: 2026-06-01",
        "strength: 0.7",
        "---",
        "",
        "SessionStart memory should put local project context before broad indexes.",
      ].join("\n"),
    );
    await writeFile(
      join(tmp, "index.md"),
      [
        "# Index",
        "",
        "## Projects",
        "",
        "- [Memory System](wiki/projects/memory-system.md) - Memory-system keeps cross-agent memory useful at session start.",
        "- [AgentMemory](wiki/projects/agentmemory.md) - AgentMemory is an older name for this memory system.",
        "",
        "## Lessons",
        "",
        "- [Session Start Memory](wiki/lessons/session-start-memory.md) - SessionStart memory should put local project context before broad indexes.",
        "",
      ].join("\n"),
    );

    const writes: string[] = [];
    await sessionStartBody(
      { cwd: "C:\\Repos\\memory-system\\.claude\\worktrees\\x" },
      { write: (text) => writes.push(text) },
    );

    const all = writes.join("");
    const projectIndex = all.indexOf("--- Current project memory");
    const relatedIndex = all.indexOf("--- Related memory");
    const globalIndex = all.indexOf("--- Index");
    expect(projectIndex).toBeGreaterThan(-1);
    expect(relatedIndex).toBeGreaterThan(projectIndex);
    expect(projectIndex).toBeLessThan(globalIndex);
    expect(all).toContain("status: active");
    expect(all).toContain("updated: 2026-06-02");
    expect(all).toContain("The current narrative body should be injected in full");
    expect(all).toContain("- AgentMemory (wiki/projects/agentmemory.md): AgentMemory is an older name");
    expect(all).toContain("- Session Start Memory (wiki/lessons/session-start-memory.md): SessionStart memory");
  });

  it("keeps stale archive index entries and physical relation targets out of project context", async () => {
    await writeProjectPage(
      tmp,
      "memory-system",
      "Current project links [[stale-archive]] and [[raw/.compact-archive/2026-05-21/retained.md]].",
      {
        relations: [
          "relations:",
          "  linked:",
          "    - wiki/tools/live-tool.md",
          "    - wiki/archive/retained-from-relation.md",
          "    - wiki/_archive/retained-from-maintenance.md",
          "    - raw/.compact-archive/2026-05-21/retained.md",
        ],
      },
    );
    await mkdir(join(tmp, "wiki", "tools"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "tools", "live-tool.md"),
      "---\ntype: tools\ntitle: Live Tool\nstrength: 0.9\nupdated: 2026-06-02\n---\n\nCurrent tool summary.\n",
    );
    await writeFile(
      join(tmp, "index.md"),
      [
        "- [Live Tool](wiki/tools/live-tool.md) - Current tool summary.",
        "- [Stale Archive](wiki/archive/stale-archive.md) - RETAINED-STALE-INDEX",
        "- [Stale Maintenance](wiki/_archive/stale-maintenance.md) - RETAINED-MAINTENANCE-INDEX",
      ].join("\n"),
    );

    const block = await currentProjectMemoryBlock({
      cwd: "C:\\Repos\\memory-system",
      memoryRoot: tmp,
    });

    expect(block).toContain("Live Tool (wiki/tools/live-tool.md)");
    const related = block!.slice(block!.indexOf("--- Related memory ---"));
    expect(block).not.toContain("raw/.compact-archive/");
    expect(block).toContain("[retained reference omitted]");
    expect(related).not.toContain("wiki/archive/");
    expect(related).not.toContain("wiki/_archive/");
    expect(related).not.toContain("raw/.compact-archive/");
    expect(related).not.toContain("RETAINED-STALE-INDEX");
    expect(related).not.toContain("RETAINED-MAINTENANCE-INDEX");
  });

  it("keeps no-match output byte-for-byte equivalent to the legacy session-start output", async () => {
    await writeSessionStartFiles(tmp);
    await writeProjectPage(tmp, "memory-system", "Memory-system body.");

    const legacyWrites: string[] = [];
    await sessionStartBody({}, { write: (text) => legacyWrites.push(text) });

    const noMatchWrites: string[] = [];
    await sessionStartBody(
      { cwd: "C:\\Repos\\misc-claude-sessions" },
      { write: (text) => noMatchWrites.push(text) },
    );

    expect(noMatchWrites.join("")).toBe(legacyWrites.join(""));
  });

  it("bounds oversized current project memory and marks truncation", async () => {
    await writeSessionStartFiles(tmp);
    await writeProjectPage(
      tmp,
      "memory-system",
      `Memory-system summary.\n\n${"oversized project body ".repeat(200)}`,
    );

    const block = await currentProjectMemoryBlock({
      cwd: "C:\\Repos\\memory-system",
      memoryRoot: tmp,
      maxChars: 600,
    });

    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(600);
    expect(block).toContain("(truncated, use MCP read_page for full)");
  });

  it("falls back to the legacy output when project-memory reads fail", async () => {
    const legacyWrites: string[] = [];
    const readFile = async (path: string): Promise<string> => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized.endsWith("/schema.md")) return "schema content";
      if (normalized.endsWith("/index.md")) return "- [Memory System](wiki/projects/memory-system.md) - Summary";
      if (normalized.endsWith("/log.md")) return "line1\nline2";
      if (normalized.endsWith("/wiki/projects/memory-system.md")) throw new Error("project read failed");
      throw new Error(`ENOENT: ${path}`);
    };
    await sessionStartBody({}, { readFile, write: (text) => legacyWrites.push(text) });

    const writes: string[] = [];
    await sessionStartBody(
      { cwd: "C:\\Repos\\memory-system" },
      { readFile, write: (text) => writes.push(text) },
    );

    expect(writes.join("")).toBe(legacyWrites.join(""));
  });

  it("omits the reminder block when there are no preferences or recent salient observations", async () => {
    await writeFile(join(tmp, "schema.md"), "schema content");
    await writeFile(join(tmp, "index.md"), "# Index\n");
    await writeFile(join(tmp, "log.md"), "line1\n");

    const writes: string[] = [];
    await sessionStartBody({}, { write: (text) => writes.push(text) });

    expect(writes.join("")).not.toContain("What you should remember");
  });

  it("surfaces preference-tagged observations even when preference pages fill the page budget", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-29"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "preferences.md"),
      [
        "---",
        "type: references",
        "title: Operator Preferences",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "tags: [preference]",
        "confidence: 1",
        "---",
        "Keep durable page preferences.",
      ].join("\n"),
    );
    await writeFile(
      join(tmp, "wiki", "projects", "also-preference.md"),
      [
        "---",
        "type: projects",
        "title: Secondary preference page",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "tags: [preference]",
        "confidence: 1",
        "---",
        "This page competes for the page budget.",
      ].join("\n"),
    );
    await writeFile(
      join(tmp, "raw", "2026-05-29", "manual-current.md"),
      [
        "---",
        "type: raw-session",
        "title: manual current",
        "created: 2026-05-29",
        "updated: 2026-05-29",
        "---",
        "",
        "## [12:00:00] Observation",
        "",
        "_tags: preference, codex · confidence: 1 · observed_at: 2026-05-29T12:00:00.000Z_",
        "",
        "PREFERENCE-FRESH-4-8 must appear even with wiki preferences present.",
      ].join("\n"),
    );

    const block = await whatToRememberBlock({ memoryRoot: tmp, maxPreferences: 1, now: new Date("2026-05-30T00:00:00.000Z") });

    expect(block).toContain("Operator Preferences");
    expect(block).toContain("PREFERENCE-FRESH-4-8");
    expect(block).not.toContain("Recent high-confidence observations");
  });

  it("orders recent observations by true write recency", async () => {
    await mkdir(join(tmp, "raw", "2026-05-28"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-29"), { recursive: true });
    const olderPath = join(tmp, "raw", "2026-05-28", "manual-old.md");
    const newerPath = join(tmp, "raw", "2026-05-29", "manual-new.md");
    await writeFile(
      olderPath,
      [
        "---",
        "type: raw-session",
        "title: old",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "---",
        "",
        "## [23:59:59] Observation",
        "",
        "_tags: project · confidence: 1_",
        "",
        "OLDER-RECENT-4-8 should not outrank the newer file.",
      ].join("\n"),
    );
    await writeFile(
      newerPath,
      [
        "---",
        "type: raw-session",
        "title: new",
        "created: 2026-05-29",
        "updated: 2026-05-29",
        "---",
        "",
        "## Observation",
        "",
        "_tags: project · confidence: 1_",
        "",
        "NEWEST-RECENT-4-8 should appear first even without a block time.",
      ].join("\n"),
    );
    await utimes(olderPath, new Date("2026-05-28T23:59:59.000Z"), new Date("2026-05-28T23:59:59.000Z"));
    await utimes(newerPath, new Date("2026-05-29T01:00:00.000Z"), new Date("2026-05-29T01:00:00.000Z"));

    const block = await whatToRememberBlock({ memoryRoot: tmp, maxRecent: 2, now: new Date("2026-05-30T00:00:00.000Z") });

    expect(block.indexOf("NEWEST-RECENT-4-8")).toBeLessThan(block.indexOf("OLDER-RECENT-4-8"));
  });

  it("never descends into out-of-window day-directories (enumeration bounded, not just reads)", async () => {
    const { readdir: realReaddir } = await import("node:fs/promises");
    for (const date of ["2020-01-01", "2026-07-10"]) {
      await mkdir(join(tmp, "raw", date), { recursive: true });
      await writeFile(join(tmp, "raw", date, "s.md"), "## [10:00:00] Observation\n\n_tags: project · confidence: 1_\n\nx\n");
    }
    const descended: string[] = [];
    await whatToRememberBlock({
      memoryRoot: tmp,
      now: new Date("2026-07-18T12:00:00.000Z"),
      readdir: (async (path: string, o: { withFileTypes: true }) => {
        descended.push(String(path).replace(/\\/g, "/"));
        return realReaddir(path, o);
      }) as never,
    });
    expect(descended.some((p) => p.endsWith("/raw"))).toBe(true); // top-level listed
    expect(descended.some((p) => p.includes("2026-07-10"))).toBe(true); // in-window descended
    expect(descended.some((p) => p.includes("2020-01-01"))).toBe(false); // out-of-window NEVER descended
  });

  it("only reads raw day-directories inside the recent window (cutoff <= date <= today)", async () => {
    const readPaths: string[] = [];
    for (const date of ["2020-01-01", "2026-07-10", "2999-01-01"]) {
      await mkdir(join(tmp, "raw", date), { recursive: true });
      await writeFile(
        join(tmp, "raw", date, "s.md"),
        `---\ntype: raw-session\ntitle: s\ncreated: ${date}\nupdated: ${date}\n---\n\n## [10:00:00] Observation\n\n_tags: project · confidence: 1_\n\nMARKER-${date}\n`,
      );
    }
    await whatToRememberBlock({
      memoryRoot: tmp,
      now: new Date("2026-07-18T00:00:00.000Z"),
      readFile: async (p: string) => { readPaths.push(p); return ""; },
    });
    // Old (>14d) and future-dated directories are never read; the recent one is.
    expect(readPaths.some((p) => p.includes("2020-01-01"))).toBe(false);
    expect(readPaths.some((p) => p.includes("2999-01-01"))).toBe(false);
    expect(readPaths.some((p) => p.includes("2026-07-10"))).toBe(true);
  });
});

describe("confidenceAwareIndex", () => {
  const oldFloor = process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"];

  afterEach(() => {
    if (oldFloor === undefined) delete process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"];
    else process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"] = oldFloor;
  });

  it("groups index entries into high, medium, and draft buckets", async () => {
    const output = await confidenceAwareIndex({
      indexFilePath: join("C:/mem", "index.md"),
      memoryRoot: "C:/mem",
      readFile: makeConfidenceReadFile(),
    });

    expect(output).toContain("--- High-confidence entries (1) ---");
    expect(output).toContain("- [[projects/high]] High");
    expect(output).toContain("--- Medium-confidence entries (1) ---");
    expect(output).toContain("- [[projects/medium]] Medium");
    expect(output).toContain("--- Low-confidence / drafts (1) ---");
    expect(output).toContain("⚠ DRAFT: - [[projects/low]] Low");
  });

  it("suppresses entries below MEMORY_FORT_INJECTION_CONF_FLOOR", async () => {
    process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"] = "0.5";

    const output = await confidenceAwareIndex({
      indexFilePath: join("C:/mem", "index.md"),
      memoryRoot: "C:/mem",
      readFile: makeConfidenceReadFile(),
    });

    expect(output).toContain("--- High-confidence entries (1) ---");
    expect(output).toContain("--- Medium-confidence entries (1) ---");
    expect(output).not.toContain("--- Low-confidence / drafts");
    expect(output).not.toContain("projects/low");
  });

  it("filters protected physical index paths before confidence reads and output", async () => {
    const readPaths: string[] = [];
    const output = await confidenceAwareIndex({
      indexFilePath: join("C:/mem", "index.md"),
      memoryRoot: "C:/mem",
      readFile: async (path: string) => {
        const normalized = path.replace(/\\/g, "/");
        readPaths.push(normalized);
        if (normalized.endsWith("/index.md")) {
          return [
            "- [Live](wiki/projects/live.md) - live context",
            "- [Archive](wiki/archive/retained.md) - retained archive context",
            "- [Canonical](wiki/_archive/retained.md) - retained canonical context",
            "- [Raw archive](raw/.compact-archive/2026-05-21/retained.md) - retained raw context",
          ].join("\n");
        }
        return "---\nconfidence: 0.9\n---\nLive page.";
      },
    });

    expect(output).toContain("wiki/projects/live.md");
    expect(output).not.toContain("retained archive context");
    expect(output).not.toContain("retained canonical context");
    expect(output).not.toContain("retained raw context");
    expect(readPaths.some((path) => path.includes("/wiki/archive/"))).toBe(false);
    expect(readPaths.some((path) => path.includes("/wiki/_archive/"))).toBe(false);
    expect(readPaths.some((path) => path.includes("/raw/.compact-archive/"))).toBe(false);
  });
});

describe("resolveProjectForCwd", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "project-resolve-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prefers the longest authoritative repo path match", async () => {
    await writeProjectPage(tmp, "outer", "Outer project.", {
      title: "Outer",
      repo: "C:\\Repos",
    });
    await writeProjectPage(tmp, "inner", "Inner project.", {
      title: "Inner",
      repo_paths: ["C:\\Repos\\memory-system", "D:\\mirror\\memory-system"],
    });

    const resolved = await resolveProjectForCwd(
      "C:\\Repos\\memory-system\\src\\hooks",
      { memoryRoot: tmp },
    );

    expect(resolved).toBe("wiki/projects/inner.md");
  });

  it("falls back to the deepest exact slug segment for worktree subpaths", async () => {
    await writeProjectPage(tmp, "memory-system", "Memory-system project.");

    const resolved = await resolveProjectForCwd(
      "C:\\Repos\\memory-system\\.claude\\worktrees\\feature-x",
      { memoryRoot: tmp },
    );

    expect(resolved).toBe("wiki/projects/memory-system.md");
  });

  it("returns null when cwd does not match a repo path or exact project slug", async () => {
    await writeProjectPage(tmp, "memory-system", "Memory-system project.");

    await expect(
      resolveProjectForCwd("C:\\Repos\\efm-paper", { memoryRoot: tmp }),
    ).resolves.toBeNull();
  });

  it("does not select a system project page for default current-project context", async () => {
    await writeProjectPage(tmp, ".retained", "System project body.", {
      repo: "C:\\Repos\\retained",
    });

    await expect(
      resolveProjectForCwd("C:\\Repos\\retained", { memoryRoot: tmp }),
    ).resolves.toBeNull();
  });
});

function makeConfidenceReadFile(): (path: string) => Promise<string> {
  return async (path) => {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.endsWith("/schema.md")) return "schema content";
    if (normalized.endsWith("/log.md")) return "line1\nline2\nline3";
    if (normalized.endsWith("/index.md")) {
      return [
        "- [[projects/high]] High",
        "- [[projects/medium]] Medium",
        "- [[projects/low]] Low",
      ].join("\n");
    }
    if (normalized.endsWith("/wiki/projects/high.md")) {
      return "---\ntitle: High\nconfidence: 0.9\n---\nHigh body.\n";
    }
    if (normalized.endsWith("/wiki/projects/medium.md")) {
      return "---\ntitle: Medium\nconfidence: 0.7\n---\nMedium body.\n";
    }
    if (normalized.endsWith("/wiki/projects/low.md")) {
      return "---\ntitle: Low\nconfidence: 0.3\n---\nLow body.\n";
    }
    throw new Error(`ENOENT: ${path}`);
  };
}

async function writeSessionStartFiles(root: string): Promise<void> {
  await writeFile(join(root, "schema.md"), "schema content");
  await writeFile(join(root, "index.md"), "# Index\n\nNo curated pages yet.\n");
  await writeFile(join(root, "log.md"), "line1\nline2");
}

async function writeProjectPage(
  root: string,
  slug: string,
  body: string,
  opts: {
    title?: string;
    updated?: string;
    status?: string;
    strength?: number;
    repo?: string;
    repo_paths?: string[];
    relations?: string[];
  } = {},
): Promise<void> {
  await mkdir(join(root, "wiki", "projects"), { recursive: true });
  const extra: string[] = [];
  if (opts.repo) extra.push(`repo: ${JSON.stringify(opts.repo)}`);
  if (opts.repo_paths) {
    extra.push("repo_paths:");
    extra.push(...opts.repo_paths.map((repoPath) => `  - ${JSON.stringify(repoPath)}`));
  }
  if (typeof opts.strength === "number") extra.push(`strength: ${opts.strength}`);
  if (opts.relations) extra.push(...opts.relations);

  await writeFile(
    join(root, "wiki", "projects", `${slug}.md`),
    [
      "---",
      "type: projects",
      `title: ${JSON.stringify(opts.title ?? slug)}`,
      "created: 2026-05-20",
      `updated: ${opts.updated ?? "2026-06-02"}`,
      `status: ${opts.status ?? "active"}`,
      ...extra,
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}
