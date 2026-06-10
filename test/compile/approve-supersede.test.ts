import { describe, it, expect } from "vitest";
import { applyApprovedSupersedeProposal } from "../../src/compile/approve-supersede.js";
import { parseFrontmatter, serializeFrontmatter } from "../../src/storage/frontmatter.js";
import { readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeProposal(overrides: Record<string, unknown> = {}) {
  return serializeFrontmatter(
    {
      type: "references",
      title: "supersede proposal: wiki/tools/old-tool.md",
      old_page: "wiki/tools/old-tool.md",
      new_page: "wiki/tools/new-tool.md",
      reason: "upgraded",
      observed_at: "2026-06-09",
      old_page_patch: { valid_until: "2026-06-09", status: "superseded" },
      created: "2026-06-09",
      updated: "2026-06-09",
      status: "active" as const,
      lifecycle: "proposed" as const,
      proposal_type: "supersede-proposal",
      proposal_status: "pending-review",
      source: "compile-execute",
      cognitive_type: "semantic" as const,
      searchable: false,
      ...overrides,
    },
    "This proposal supersedes wiki/tools/old-tool.md.\n"
  );
}

async function setupVault() {
  const root = await mkdtemp(join(tmpdir(), "mf-approve-"));
  const wikiDir = join(root, "wiki", "tools");
  const proposedDir = join(root, "wiki", "compile-proposed");
  const archiveDir = join(root, "wiki", ".archive");
  await mkdir(wikiDir, { recursive: true });
  await mkdir(proposedDir, { recursive: true });

  await writeFile(
    join(wikiDir, "old-tool.md"),
    serializeFrontmatter(
      { type: "tools", title: "Old Tool", created: "2025-01-01", updated: "2025-06-01", status: "active" as const },
      "old body\n"
    ),
  );

  // Replacement page must exist
  await writeFile(
    join(wikiDir, "new-tool.md"),
    serializeFrontmatter(
      { type: "tools", title: "New Tool", created: "2026-06-09", updated: "2026-06-09", status: "active" as const },
      "new body\n"
    ),
  );

  return { root, wikiDir, proposedDir, archiveDir };
}

describe("applyApprovedSupersedeProposal", () => {
  it("stamps valid_until, status, and superseded_by on old page", async () => {
    const { root, wikiDir, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-old-tool-12345.md");
    await writeFile(proposalPath, makeProposal());

    const now = new Date("2026-06-10T08:00:00Z");
    const result = await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath, now });

    expect(result.ok).toBe(true);

    const oldPage = parseFrontmatter(await readFile(join(wikiDir, "old-tool.md"), "utf-8"));
    expect(oldPage.frontmatter.valid_until).toBe("2026-06-09");
    expect(oldPage.frontmatter.status).toBe("superseded");
    expect(oldPage.frontmatter.updated).toBe("2026-06-10");
    expect(oldPage.frontmatter["superseded_by"]).toBe("wiki/tools/new-tool.md");
  });

  it("patched old page still passes frontmatter validation", async () => {
    const { root, wikiDir, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-old-tool-12345.md");
    await writeFile(proposalPath, makeProposal());

    await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath });

    const { validateFrontmatter } = await import("../../src/storage/frontmatter.js");
    const oldPage = parseFrontmatter(await readFile(join(wikiDir, "old-tool.md"), "utf-8"));
    const validation = validateFrontmatter(oldPage.frontmatter);
    expect(validation.valid).toBe(true);
  });

  it("marks proposal as approved", async () => {
    const { root, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-old-tool-12345.md");
    await writeFile(proposalPath, makeProposal());

    const now = new Date("2026-06-10T08:00:00Z");
    await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath, now });

    const proposalUpdated = parseFrontmatter(await readFile(proposalPath, "utf-8"));
    expect(proposalUpdated.frontmatter["proposal_status"]).toBe("approved");
  });

  it("archives old page version before patching", async () => {
    const { root, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-old-tool-12345.md");
    await writeFile(proposalPath, makeProposal());

    await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath });

    const archiveDir = join(root, "wiki", ".archive");
    const archiveFiles = await readdir(archiveDir).catch(() => [] as string[]);
    expect(archiveFiles.length).toBeGreaterThan(0);
    const archiveContent = await readFile(join(archiveDir, archiveFiles[0]!), "utf-8");
    expect(archiveContent).toContain("Old Tool");
    expect(archiveContent).toContain("status: active");
  });

  it("returns error if old page does not exist", async () => {
    const { root, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-missing-12345.md");
    await writeFile(proposalPath, makeProposal({ old_page: "wiki/tools/missing.md" }));

    const result = await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not found");
  });

  it("returns error if replacement page does not exist", async () => {
    const { root, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-old-tool-12345.md");
    await writeFile(proposalPath, makeProposal({ new_page: "wiki/tools/nonexistent.md" }));

    const result = await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("replacement page not found");
  });

  it("rejects proposal path outside wiki/compile-proposed/", async () => {
    const { root, wikiDir } = await setupVault();
    const fakePath = join(wikiDir, "old-tool.md");

    const result = await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath: fakePath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must be inside wiki/compile-proposed");
  });

  it("rejects old_page with path traversal", async () => {
    const { root, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-escape-12345.md");
    await writeFile(proposalPath, makeProposal({ old_page: "../../etc/passwd" }));

    const result = await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("path traversal blocked");
  });

  it("is idempotent — re-approving an already-approved proposal succeeds", async () => {
    const { root, wikiDir, proposedDir } = await setupVault();
    const proposalPath = join(proposedDir, "supersede-old-tool-12345.md");
    await writeFile(proposalPath, makeProposal());

    const now = new Date("2026-06-10T08:00:00Z");
    const first = await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath, now });
    const second = await applyApprovedSupersedeProposal({ vaultRoot: root, proposalPath, now });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // Old page still correct after second run
    const oldPage = parseFrontmatter(await readFile(join(wikiDir, "old-tool.md"), "utf-8"));
    expect(oldPage.frontmatter.status).toBe("superseded");
  });
});
