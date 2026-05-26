import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";

function page(frontmatter: Record<string, unknown>, body = "Body.\n"): string {
  const lines = Object.entries(frontmatter).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return [`${key}:`, ...value.map((item) => `  - ${item}`)];
    }
    if (typeof value === "object" && value !== null) {
      return [
        `${key}:`,
        ...Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) => [
          `  ${childKey}:`,
          ...(Array.isArray(childValue) ? childValue.map((item) => `    - ${item}`) : [`    - ${childValue}`]),
        ]),
      ];
    }
    return [`${key}: ${value}`];
  });
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

async function writeMarkdown(vaultRoot: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content);
}

describe("cognitive type inference", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cognitive-type-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("uses explicit frontmatter cognitive_type before inference", async () => {
    await writeMarkdown(
      tmp,
      "wiki/references/explicit.md",
      page({
        type: "references",
        title: "Explicit",
        cognitive_type: "core",
      }),
    );

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.documents[0]?.cognitiveType).toBe("core");
  });

  it("infers semantic for crystal source or crystal category", async () => {
    await writeMarkdown(
      tmp,
      "crystals/one.md",
      page({
        type: "crystal",
        title: "One",
        source: "crystal",
      }),
    );

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "crystals" });

    expect(result.documents[0]?.cognitiveType).toBe("semantic");
  });

  it("infers episodic for agent raw observations", async () => {
    await writeMarkdown(tmp, "raw/2026-05-24/codex-session.md", "# Session\n\nObservation.\n");

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "raw" });

    expect(result.documents[0]?.cognitiveType).toBe("episodic");
  });

  it("infers procedural for tools and lessons", async () => {
    await writeMarkdown(tmp, "wiki/tools/tool.md", page({ type: "tools", title: "Tool" }));
    await writeMarkdown(tmp, "wiki/lessons/lesson.md", page({ type: "lessons", title: "Lesson" }));

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(Object.fromEntries(result.documents.map((document) => [document.relPath, document.cognitiveType]))).toEqual({
      "wiki/lessons/lesson.md": "procedural",
      "wiki/tools/tool.md": "procedural",
    });
  });

  it("infers core for active projects with at least five inbound edges", async () => {
    await writeMarkdown(
      tmp,
      "wiki/projects/core.md",
      page({ type: "projects", title: "Core", status: "active" }),
    );
    for (let index = 0; index < 5; index += 1) {
      await writeMarkdown(
        tmp,
        `wiki/references/ref-${index}.md`,
        page({ type: "references", title: `Reference ${index}` }, "See [[projects/core]].\n"),
      );
    }

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.documents.find((document) => document.relPath === "wiki/projects/core.md")?.cognitiveType).toBe("core");
  });

  it("infers episodic for active decisions created within the last fourteen days", async () => {
    await writeMarkdown(
      tmp,
      "wiki/decisions/recent.md",
      page({
        type: "decisions",
        title: "Recent",
        status: "active",
        created: new Date().toISOString().slice(0, 10),
      }),
    );

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.documents[0]?.cognitiveType).toBe("episodic");
  });

  it("defaults to semantic when no branch matches", async () => {
    await writeMarkdown(tmp, "wiki/references/default.md", page({ type: "references", title: "Default" }));

    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });

    expect(result.documents[0]?.cognitiveType).toBe("semantic");
  });
});
