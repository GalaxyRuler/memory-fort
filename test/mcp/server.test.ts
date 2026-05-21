import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logObservation, readPage, listPages } from "../../src/mcp/server.js";

describe("logObservation", () => {
  let tmp: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mcp-log-"));
    origEnv = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  it("appends an observation to today's raw file", async () => {
    const result = await logObservation({ text: "remember this", tags: ["a", "b"] });
    expect(result.content[0]!.text).toMatch(/Logged observation/);
    const date = new Date().toISOString().slice(0, 10);
    const rawDir = join(tmp, "raw", date);
    expect(existsSync(rawDir)).toBe(true);
    const files = await readdir(rawDir);
    expect(files.length).toBe(1);
    const content = await readFile(join(rawDir, files[0]!), "utf-8");
    expect(content).toContain("remember this");
    expect(content).toContain("tags: a, b");
  });

  it("uses source field to set tool name in filename", async () => {
    await logObservation({ text: "x", source: "manual" });
    const date = new Date().toISOString().slice(0, 10);
    const rawDir = join(tmp, "raw", date);
    const files = await readdir(rawDir);
    expect(files[0]).toMatch(/^manual-/);
  });
});

describe("readPage", () => {
  let tmp: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mcp-read-"));
    origEnv = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "agentmemory.md"),
      `---\ntype: projects\ntitle: agentmemory\ncreated: "2026-05-20"\nupdated: "2026-05-21"\ntags: [windows, stability]\n---\n\nThe summary.\n\nBody content.\n`,
    );
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads a wiki page and returns formatted content", async () => {
    const result = await readPage({ path: "projects/agentmemory.md" });
    const text = result.content[0]!.text;
    expect(text).toContain("# agentmemory");
    expect(text).toContain("**Type:** projects");
    expect(text).toContain("Body content");
    expect(text).toContain("windows, stability");
  });

  it("returns isError on missing page", async () => {
    const result = await readPage({ path: "projects/missing.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("rejects path traversal attempts", async () => {
    const result = await readPage({ path: "../../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid path");
  });

  it("rejects absolute Windows paths", async () => {
    const result = await readPage({ path: "C:/Windows/system32/secret.md" });
    expect(result.isError).toBe(true);
  });
});

describe("listPages", () => {
  let tmp: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mcp-list-"));
    origEnv = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "a.md"),
      `---\ntype: projects\ntitle: A\ncreated: "2026-05-20"\nupdated: "2026-05-20"\ntags: [windows]\n---\nx\n`,
    );
    await writeFile(
      join(tmp, "wiki", "projects", "b.md"),
      `---\ntype: projects\ntitle: B\ncreated: "2026-05-21"\nupdated: "2026-05-21"\nstatus: archived\n---\ny\n`,
    );
    await writeFile(
      join(tmp, "wiki", "lessons", "c.md"),
      `---\ntype: lessons\ntitle: C\ncreated: "2026-05-20"\nupdated: "2026-05-20"\ntags: [stability, windows]\n---\nz\n`,
    );
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  it("lists all pages when no filters set", async () => {
    const result = await listPages({});
    const text = result.content[0]!.text;
    expect(text).toContain("Found 3 pages");
    expect(text).toContain("projects/a.md");
    expect(text).toContain("projects/b.md");
    expect(text).toContain("lessons/c.md");
  });

  it("filters by type", async () => {
    const result = await listPages({ type: "lessons" });
    const text = result.content[0]!.text;
    expect(text).toContain("Found 1 page");
    expect(text).toContain("lessons/c.md");
    expect(text).not.toContain("projects/");
  });

  it("filters by tag", async () => {
    const result = await listPages({ tag: "windows" });
    const text = result.content[0]!.text;
    expect(text).toContain("Found 2 pages");
    expect(text).toContain("projects/a.md");
    expect(text).toContain("lessons/c.md");
  });

  it("filters by status archived", async () => {
    const result = await listPages({ status: "archived" });
    const text = result.content[0]!.text;
    expect(text).toContain("Found 1 page");
    expect(text).toContain("projects/b.md");
  });

  it("returns no-match message when filters match nothing", async () => {
    const result = await listPages({ tag: "nonexistent" });
    expect(result.content[0]!.text).toMatch(/No pages match/);
  });
});
