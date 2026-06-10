import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";

// Regression: temporal (valid_from/valid_until) and identity (agent_id/user_id)
// search filters read doc.rawFrontmatter. It must be populated for EVERY doc
// kind — originally only raw observations imported from agentmemory carried it,
// which made as_of filtering a silent no-op on wiki pages.
describe("corpus rawFrontmatter population", () => {
  it("wiki pages carry their parsed frontmatter including temporal fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-corpus-rfm-"));
    const wikiDir = join(root, "wiki", "tools");
    await mkdir(wikiDir, { recursive: true });
    await writeFile(
      join(wikiDir, "expired.md"),
      [
        "---",
        "type: tools",
        'title: "Expired Tool"',
        'created: "2025-01-01"',
        'updated: "2025-06-01"',
        'valid_from: "2025-01-01"',
        'valid_until: "2025-12-31"',
        "---",
        "",
        "Legacy tooling page.",
        "",
      ].join("\n"),
    );

    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "all" });
    const doc = corpus.documents.find((d) => d.relPath.endsWith("expired.md"));
    expect(doc).toBeDefined();
    expect(doc!.rawFrontmatter).toBeTruthy();
    expect(doc!.rawFrontmatter!["valid_until"]).toBe("2025-12-31");
    expect(doc!.rawFrontmatter!["valid_from"]).toBe("2025-01-01");
  });

  it("raw session files carry identity fields in rawFrontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-corpus-rfm-raw-"));
    const rawDir = join(root, "raw", "2026-06-10");
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      join(rawDir, "codex-ident.md"),
      [
        "---",
        "type: raw-session",
        'title: "codex session ident"',
        'created: "2026-06-10"',
        'updated: "2026-06-10"',
        "source: codex",
        'session: "ident"',
        "agent_id: codex-prod",
        "user_id: alice",
        "---",
        "",
        "## [10:00:00] Observation",
        "",
        "identity-tagged capture",
        "",
      ].join("\n"),
    );

    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "all" });
    const doc = corpus.documents.find((d) => d.relPath.endsWith("codex-ident.md"));
    expect(doc).toBeDefined();
    expect(doc!.rawFrontmatter).toBeTruthy();
    expect(doc!.rawFrontmatter!["agent_id"]).toBe("codex-prod");
    expect(doc!.rawFrontmatter!["user_id"]).toBe("alice");
  });
});
