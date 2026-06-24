import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";

function frontmatterPage(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const lines = Object.entries(frontmatter).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return [`${key}:`, ...value.map((item) => `  - ${item}`)];
    }
    if (typeof value === "object" && value !== null) {
      return [
        `${key}:`,
        ...Object.entries(value as Record<string, unknown>).flatMap(
          ([childKey, childValue]) => [
            `  ${childKey}:`,
            ...(Array.isArray(childValue)
              ? childValue.map((item) => `    - ${item}`)
              : [`    - ${childValue}`]),
          ],
        ),
      ];
    }
    return [`${key}: ${value}`];
  });
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

async function writeMarkdown(
  vaultRoot: string,
  relPath: string,
  content: string,
): Promise<string> {
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}

async function writeMixedVault(vaultRoot: string): Promise<void> {
  await writeMarkdown(
    vaultRoot,
    "wiki/projects/foo.md",
    frontmatterPage(
      {
        type: "projects",
        title: "Foo",
        created: "2026-05-22",
        updated: "2026-05-23",
      },
      "Foo body.\n",
    ),
  );
  await writeMarkdown(
    vaultRoot,
    "wiki/lessons/bar.md",
    frontmatterPage(
      {
        type: "lessons",
        title: "Bar",
        created: "2026-05-22",
        updated: "2026-05-23",
      },
      "Bar body.\n",
    ),
  );
  await writeMarkdown(vaultRoot, "raw/2026-05-22/codex-raw.md", "Raw body.\n");
  await writeMarkdown(
    vaultRoot,
    "crystals/crystal-one.md",
    frontmatterPage(
      {
        type: "crystal",
        title: "Crystal One",
        created: "2026-05-22",
        updated: "2026-05-23",
        source: "crystal",
      },
      "Crystal body.\n",
    ),
  );
}

describe("retrieval corpus loader", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "corpus-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("Empty vault returns empty documents array", async () => {
    await expect(loadSearchCorpus({ vaultRoot: tmp })).resolves.toEqual({
      documents: [],
      errors: [],
      rawTruncated: false,
      scannedCounts: { wiki: 0, raw: 0, crystals: 0 },
    });
  });

  it("Scope filter: wiki returns only wiki documents", async () => {
    await writeMixedVault(tmp);

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.documents).toHaveLength(2);
    expect(result.documents.every((document) => document.kind === "wiki")).toBe(
      true,
    );
    expect(result.scannedCounts).toEqual({ wiki: 2, raw: 1, crystals: 1 });
  });

  it("excludes wiki dot-directories from the searchable corpus", async () => {
    await writeMarkdown(
      tmp,
      "wiki/projects/foo.md",
      frontmatterPage(
        {
          type: "projects",
          title: "Foo",
          created: "2026-05-22",
          updated: "2026-05-23",
        },
        "Foo body.\n",
      ),
    );
    await writeMarkdown(
      tmp,
      "wiki/.audit/llm-2026-05-29.md",
      frontmatterPage(
        {
          type: "references",
          title: "Audit Log",
          created: "2026-05-29",
          updated: "2026-05-29",
        },
        "Operational audit body.\n",
      ),
    );

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.documents.map((document) => document.relPath)).toEqual(["wiki/projects/foo.md"]);
    expect(result.scannedCounts.wiki).toBe(1);
  });

  it("Scope filter: raw returns only raw documents", async () => {
    await writeMixedVault(tmp);

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "raw" });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.kind).toBe("raw");
  });

  it("Scope filter: all returns wiki + raw + crystals", async () => {
    await writeMixedVault(tmp);

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "all" });

    expect(result.documents).toHaveLength(4);
  });

  it("SearchDocument fields populated correctly for a wiki page", async () => {
    await writeMarkdown(
      tmp,
      "wiki/projects/foo.md",
      frontmatterPage(
        {
          type: "projects",
          title: "Foo",
          status: "active",
          confidence: 0.8,
          tags: ["a", "b"],
          relations: { uses: ["bar"] },
          source: "claude-code",
          session: "abc123",
          updated: "2026-05-22",
        },
        "First summary line.\n\nMore content.",
      ),
    );
    await writeMarkdown(tmp, "wiki/projects/broken.md", "---\ntitle: Broken\n");

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });
    const document = result.documents[0];

    expect(result.documents).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("wiki/projects/broken.md");
    expect(result.errors[0]?.reason).toContain("frontmatter");
    expect(document).toMatchObject({
      kind: "wiki",
      relPath: "wiki/projects/foo.md",
      title: "Foo",
      type: "projects",
      status: "active",
      confidence: 0.8,
      tags: ["a", "b"],
      relations: { uses: [{ target: "bar" }] },
      source: "claude-code",
      session: "abc123",
      updated: "2026-05-22",
    });
    expect(document?.snippetSource).toMatch(/^First summary line\./);
  });

  it("parses block-style typed temporal relation frontmatter", async () => {
    await writeMarkdown(
      tmp,
      "wiki/projects/rich.md",
      `---
type: projects
title: Rich Relations
created: "2026-05-20"
updated: "2026-05-21"
relations:
  uses:
    - target: wiki/tools/old.md
      valid_from: "2026-05-20"
      valid_to: "2026-05-23"
      superseded_by: wiki/tools/new.md
      confidence: 0.9
---

Body.
`,
    );

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.errors).toEqual([]);
    expect(result.documents[0]?.relations).toEqual({
      uses: [{
        target: "wiki/tools/old.md",
        valid_from: "2026-05-20",
        valid_to: "2026-05-23",
        superseded_by: "wiki/tools/new.md",
        confidence: 0.9,
      }],
    });
  });

  it("Raw source detection from filename pattern", async () => {
    await writeMarkdown(tmp, "raw/2026-05-22/claude-code-abc.md", "A\n");
    await writeMarkdown(tmp, "raw/2026-05-22/codex-xyz.md", "B\n");
    await writeMarkdown(tmp, "raw/2026-05-22/manual-mcp-123.md", "C\n");
    await writeMarkdown(tmp, "raw/2026-05-22/unknown-foo.md", "D\n");

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "raw" });
    const byName = Object.fromEntries(
      result.documents.map((document) => [
        document.relPath.split("/").at(-1),
        document,
      ]),
    );

    expect(byName["claude-code-abc.md"]?.source).toBe("claude-code");
    expect(byName["claude-code-abc.md"]?.session).toBe("abc");
    expect(byName["codex-xyz.md"]?.source).toBe("codex");
    expect(byName["codex-xyz.md"]?.session).toBe("xyz");
    expect(byName["manual-mcp-123.md"]?.source).toBe("manual");
    expect(byName["manual-mcp-123.md"]?.session).toBe("mcp-123");
    expect(byName["unknown-foo.md"]?.source).toBe("unknown");
    expect(byName["unknown-foo.md"]?.session).toBe("foo");
  });

  it("canonicalizes raw observations across agent frontmatter variants", async () => {
    await writeMarkdown(
      tmp,
      "raw/2026-05-24/claude-code-claude123.md",
      frontmatterPage(
        {
          source: "claude-code",
          session_id: "claude-session-1",
          tags: ["GraphCanvas"],
        },
        "# GraphCanvas resize fix\n\nTool: edit src/dashboard-ui/components/GraphCanvas.tsx\n\nClaude noted the resize fix.\n",
      ),
    );
    await writeMarkdown(
      tmp,
      "raw/2026-05-24/codex-codex456.md",
      frontmatterPage(
        {
          source: "codex",
          sessionId: "codex-session-2",
        },
        "# GraphCanvas resize fix\n\nUsed tool: apply_patch\n\nCodex adjusted the same sizing path.\n",
      ),
    );
    await writeMarkdown(
      tmp,
      "raw/2026-05-24/antigravity-ag789.md",
      frontmatterPage(
        {
          source: "antigravity",
          conversation_id: "antigravity-session-3",
        },
        "# GraphCanvas resize fix\n\nUsed tool: browser\n\nAntigravity verified the rendered graph view.\n",
      ),
    );

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "raw" });
    const byName = Object.fromEntries(
      result.documents.map((document) => [
        document.relPath.split("/").at(-1),
        document,
      ]),
    );

    expect(byName["claude-code-claude123.md"]).toMatchObject({
      source: "claude-code",
      session: "claude-session-1",
      agentSessionId: "claude-session-1",
      confidence: 0.75,
      title: "GraphCanvas resize fix",
      toolCallsSummary: ["edit src/dashboard-ui/components/GraphCanvas.tsx"],
      rawFrontmatter: expect.objectContaining({ session_id: "claude-session-1" }),
    });
    expect(byName["codex-codex456.md"]).toMatchObject({
      source: "codex",
      session: "codex-session-2",
      agentSessionId: "codex-session-2",
      confidence: 0.75,
      title: "GraphCanvas resize fix",
      toolCallsSummary: ["apply_patch"],
      rawFrontmatter: expect.objectContaining({ sessionId: "codex-session-2" }),
    });
    expect(byName["antigravity-ag789.md"]).toMatchObject({
      source: "antigravity",
      session: "antigravity-session-3",
      agentSessionId: "antigravity-session-3",
      confidence: 0.6,
      title: "GraphCanvas resize fix",
      toolCallsSummary: ["browser"],
      rawFrontmatter: expect.objectContaining({
        conversation_id: "antigravity-session-3",
      }),
    });

    for (const document of result.documents) {
      expect(document.topicTags).toEqual(
        expect.arrayContaining(["graphcanvas", "resize", "fix"]),
      );
      expect(document.tags).toEqual(
        expect.arrayContaining(["graphcanvas", "resize", "fix"]),
      );
      expect(document.body).toContain("canonical topics: graphcanvas resize fix");
    }
  });

  it("mtime captured and sizeBytes correct", async () => {
    const fullPath = await writeMarkdown(
      tmp,
      "wiki/projects/foo.md",
      frontmatterPage({ type: "projects", title: "Foo" }, "Body.\n"),
    );
    const mtime = new Date("2026-05-22T10:11:12.000Z");
    await utimes(fullPath, mtime, mtime);

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });
    const actualStat = await stat(fullPath);

    expect(result.documents[0]?.mtime).toBe(mtime.toISOString());
    expect(result.documents[0]?.sizeBytes).toBe(actualStat.size);
  });

  it("Forward-slash paths regardless of platform", async () => {
    await writeMarkdown(
      tmp,
      "wiki/projects/foo.md",
      frontmatterPage({ type: "projects", title: "Foo" }, "Body.\n"),
    );

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.documents[0]?.relPath).toBe("wiki/projects/foo.md");
    expect(result.documents[0]?.relPath).not.toContain("\\");
  });
});
