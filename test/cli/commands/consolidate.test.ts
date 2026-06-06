import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatConsolidateResult,
  runConsolidate,
} from "../../../src/cli/commands/consolidate.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runConsolidate", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-consolidate-"));
    await writePage(
      "wiki/decisions/voyage-ai-for-embeddings.md",
      "Voyage AI for embeddings",
      "Embeddings retrieval semantic recall reranking Voyage provider decision.",
    );
    await writePage(
      "wiki/projects/memory-fort.md",
      "Memory Fort",
      "The local memory system project and dashboard.",
    );
    await writeRaw(
      "raw/2026-05-27/codex-session.md",
      "A session",
      "We discussed Voyage AI and Memory Fort today.\nBody stays exactly here.\n",
    );
    await writeRaw(
      "raw/2026-05-27/already-linked.md",
      "Already linked",
      "Voyage AI appears but this file already has relations.\n",
      ["wiki/projects/memory-fort.md"],
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans proposed relations without writing raw files", async () => {
    const before = await readFile(join(tmp, "raw", "2026-05-27", "codex-session.md"), "utf-8");

    const result = await runConsolidate({
      plan: true,
      corpusRoot: tmp,
      minConfidence: 0.6,
      maxLinksPerObservation: 5,
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    expect(result.summary.scanned).toBe(2);
    expect(result.summary.proposed).toBe(1);
    expect(result.summary.proposedEdges).toBe(2);
    expect(result.summary.updated).toBe(0);
    expect(result.plans.find((plan) => plan.observation.endsWith("codex-session.md"))?.willWrite).toBe(true);
    expect(formatConsolidateResult(result)).toContain("Memory consolidate plan");
    await expect(readFile(join(tmp, "raw", "2026-05-27", "codex-session.md"), "utf-8")).resolves.toBe(before);
  });

  it("applies proposed mentions, preserves body, and writes an audit log", async () => {
    const before = parseFrontmatter(await readFile(join(tmp, "raw", "2026-05-27", "codex-session.md"), "utf-8"));
    const result = await runConsolidate({
      plan: false,
      corpusRoot: tmp,
      minConfidence: 0.6,
      maxLinksPerObservation: 5,
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    expect(result.summary.updated).toBe(1);
    expect(result.summary.newEdges).toBe(2);
    expect(result.auditLogPath).toBe(join(tmp, "wiki", ".audit", "consolidate-2026-05-27T10-00-00-000Z.md"));
    expect(existsSync(result.auditLogPath!)).toBe(true);

    const raw = parseFrontmatter(await readFile(join(tmp, "raw", "2026-05-27", "codex-session.md"), "utf-8"));
    expect(raw.frontmatter.relations?.mentions).toEqual([
      "wiki/projects/memory-fort.md",
      "wiki/decisions/voyage-ai-for-embeddings.md",
    ]);
    expect(raw.body).toBe(before.body);

    const audit = await readFile(result.auditLogPath!, "utf-8");
    expect(audit).toContain("total scanned: 2");
    expect(audit).toContain("total proposed observations: 1");
    expect(audit).toContain("total proposed edges: 2");
    expect(audit).toContain("total updated: 1");
    expect(audit).toContain("Voyage AI");
    expect(parseFrontmatter(audit).frontmatter.source).toBe("consolidate");
  });

  it("writes mixed typed relation buckets and force overwrites the old relation map", async () => {
    await writePage(
      "wiki/tools/vitest.md",
      "Vitest",
      "Fast local test runner for TypeScript projects.",
    );
    await writePage(
      "wiki/crystals/validation-is-key.md",
      "Validation is key",
      "Verification evidence should survive through the graph.",
    );
    await writeRaw(
      "raw/2026-05-27/typed-session.md",
      "Typed session",
      "Vitest helped. Validation is key.\n",
      ["wiki/projects/memory-fort.md"],
    );

    const result = await runConsolidate({
      plan: false,
      force: true,
      corpusRoot: tmp,
      minConfidence: 0.6,
      maxLinksPerObservation: 5,
      now: new Date("2026-05-27T10:03:00.000Z"),
    });

    expect(result.plans.find((plan) => plan.observation.endsWith("typed-session.md"))?.willWrite).toBe(true);
    const raw = parseFrontmatter(await readFile(join(tmp, "raw", "2026-05-27", "typed-session.md"), "utf-8"));
    expect(raw.frontmatter.relations?.uses).toEqual(["wiki/tools/vitest.md"]);
    expect(raw.frontmatter.relations?.derived_from).toEqual(["wiki/crystals/validation-is-key.md"]);
    expect(raw.frontmatter.relations?.mentions).toBeUndefined();
  });

  it("is idempotent unless force is enabled", async () => {
    const first = await runConsolidate({
      plan: false,
      corpusRoot: tmp,
      now: new Date("2026-05-27T10:00:00.000Z"),
    });
    const second = await runConsolidate({
      plan: false,
      corpusRoot: tmp,
      now: new Date("2026-05-27T10:01:00.000Z"),
    });
    const forced = await runConsolidate({
      plan: true,
      force: true,
      corpusRoot: tmp,
      now: new Date("2026-05-27T10:02:00.000Z"),
    });

    expect(first.summary.updated).toBe(1);
    expect(second.summary.updated).toBe(0);
    expect(forced.plans.find((plan) => plan.observation.endsWith("already-linked.md"))?.willWrite).toBe(true);
  });

  it("skips observations with any existing relation type unless force is enabled", async () => {
    await writeRaw(
      "raw/2026-05-27/already-typed.md",
      "Already typed",
      "Vitest appears here after the typed relation was curated.\n",
      [],
      { uses: ["wiki/tools/vitest.md"] },
    );
    await writePage(
      "wiki/tools/vitest.md",
      "Vitest",
      "Fast local test runner for TypeScript projects.",
    );

    const result = await runConsolidate({
      plan: true,
      corpusRoot: tmp,
      minConfidence: 0.6,
      maxLinksPerObservation: 5,
      now: new Date("2026-05-27T10:04:00.000Z"),
    });
    const forced = await runConsolidate({
      plan: true,
      force: true,
      corpusRoot: tmp,
      minConfidence: 0.6,
      maxLinksPerObservation: 5,
      now: new Date("2026-05-27T10:05:00.000Z"),
    });

    expect(result.plans.find((plan) => plan.observation.endsWith("already-typed.md"))?.willWrite).toBe(false);
    expect(forced.plans.find((plan) => plan.observation.endsWith("already-typed.md"))?.willWrite).toBe(true);
  });

  async function writePage(relPath: string, title: string, body: string): Promise<void> {
    await writeMarkdown(relPath, [
      "---",
      "type: decisions",
      `title: ${title}`,
      "created: 2026-05-27",
      "updated: 2026-05-27",
      "---",
      "",
      body,
    ].join("\n"));
  }

  async function writeRaw(
    relPath: string,
    title: string,
    body: string,
    mentions: string[] = [],
    relations: Record<string, string[]> = {},
  ): Promise<void> {
    const allRelations = {
      ...(mentions.length > 0 ? { mentions } : {}),
      ...relations,
    };
    const relationLines = Object.keys(allRelations).length > 0
      ? [
          "relations:",
          ...Object.entries(allRelations).flatMap(([key, targets]) => [
            `  ${key}:`,
            ...targets.map((target) => `    - ${target}`),
          ]),
        ]
      : [];
    await writeMarkdown(relPath, [
      "---",
      "type: raw-session",
      `title: ${title}`,
      "created: 2026-05-27",
      "updated: 2026-05-27",
      ...relationLines,
      "---",
      "",
      body,
    ].join("\n"));
  }

  async function writeMarkdown(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});
