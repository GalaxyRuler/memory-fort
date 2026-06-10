import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePostObservation, handleGetPages } from "../../src/dashboard/api-handlers.js";

describe("POST /api/observations", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), "mf-api-test-"));
    await mkdir(join(vaultRoot, "raw"), { recursive: true });
  });

  it("returns 400 when text is missing", async () => {
    const result = await handlePostObservation({ body: {}, vaultRoot });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "missing required field: text" });
  });

  it("returns 400 when text is empty string", async () => {
    const result = await handlePostObservation({ body: { text: "  " }, vaultRoot });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "missing required field: text" });
  });

  it("returns 200 with session id on valid input", async () => {
    const result = await handlePostObservation({ body: { text: "test observation" }, vaultRoot });
    expect(result.status).toBe(200);
    expect(result.body["ok"]).toBe(true);
    expect(typeof result.body["session"]).toBe("string");
  });

  it("writes the observation into the configured vaultRoot", async () => {
    await handlePostObservation({ body: { text: "vault-scoped observation" }, vaultRoot });
    const rawDir = join(vaultRoot, "raw");
    const dates = await readdir(rawDir);
    expect(dates.length).toBe(1);
    const files = await readdir(join(rawDir, dates[0]!));
    expect(files.length).toBe(1);
    const content = await readFile(join(rawDir, dates[0]!, files[0]!), "utf-8");
    expect(content).toContain("vault-scoped observation");
    expect(content).toContain("type: raw-session");
  });

  it("accepts optional tags and confidence", async () => {
    const result = await handlePostObservation({
      body: { text: "test", tags: ["infra"], confidence: 0.9 },
      vaultRoot,
    });
    expect(result.status).toBe(200);
  });
});

describe("GET /api/pages", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), "mf-api-pages-"));
    const wikiDir = join(vaultRoot, "wiki", "tools");
    await mkdir(wikiDir, { recursive: true });
    await writeFile(
      join(wikiDir, "voyage.md"),
      "---\ntype: tools\ntitle: Voyage AI\ncreated: \"2026-01-01\"\nupdated: \"2026-01-01\"\nstatus: active\n---\nVoyage body\n",
    );
  });

  it("returns page metadata array", async () => {
    const result = await handleGetPages({ vaultRoot });
    expect(result.status).toBe(200);
    const pages = result.body["pages"] as Array<Record<string, unknown>>;
    expect(Array.isArray(pages)).toBe(true);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]).toHaveProperty("title", "Voyage AI");
    expect(pages[0]).toHaveProperty("path", "wiki/tools/voyage.md");
    expect(pages[0]).toHaveProperty("status", "active");
  });

  it("filters by type parameter", async () => {
    const result = await handleGetPages({ vaultRoot, type: "decisions" });
    expect(result.status).toBe(200);
    expect(result.body["pages"]).toHaveLength(0); // only "tools" exists
  });

  it("skips dot-directories", async () => {
    const dotDir = join(vaultRoot, "wiki", ".archive");
    await mkdir(dotDir, { recursive: true });
    await writeFile(
      join(dotDir, "old.md"),
      "---\ntype: tools\ntitle: Old\ncreated: \"2025-01-01\"\nupdated: \"2025-01-01\"\n---\nold\n",
    );
    const result = await handleGetPages({ vaultRoot });
    const pages = result.body["pages"] as Array<{ path: string }>;
    expect(pages.every((p) => !p.path.includes(".archive"))).toBe(true);
  });
});
