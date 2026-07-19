import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hashCompileOperationForLedger,
  isProposalResolved,
  readResolvedProposals,
  recordProposalResolved,
  resolvedProposalsPath,
} from "../../src/compile/proposal-ledger.js";

describe("proposal ledger", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "proposal-ledger-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const operation = {
    kind: "rewrite_page",
    path: "wiki/projects/example.md",
    body: "Example body.",
  };

  it("reports unresolved for an empty vault", async () => {
    expect(await isProposalResolved(tmp, operation)).toBe(false);
    expect(await readResolvedProposals(tmp)).toEqual({});
  });

  it("records an approval and reports the identical operation as resolved", async () => {
    await recordProposalResolved(tmp, operation, "approved", {
      now: new Date("2026-06-11T00:00:00Z"),
      path: "wiki/projects/example.md",
    });

    expect(await isProposalResolved(tmp, operation)).toBe(true);
    const ledger = JSON.parse(await readFile(resolvedProposalsPath(tmp), "utf-8"));
    const entry = ledger.resolved[hashCompileOperationForLedger(operation)];
    expect(entry).toMatchObject({
      action: "approved",
      resolvedAt: "2026-06-11T00:00:00.000Z",
      path: "wiki/projects/example.md",
    });
  });

  it("treats rewrite_page without frontmatter as the same as frontmatter: {}", async () => {
    // Dashboard promote/reject records via parseCompileOperationBlock which
    // always includes frontmatter: {}; stage paths must match that key.
    await recordProposalResolved(
      tmp,
      {
        kind: "rewrite_page",
        path: "wiki/projects/example.md",
        body: "Example body.",
        frontmatter: {},
      },
      "rejected",
    );

    expect(await isProposalResolved(tmp, {
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body: "Example body.",
    })).toBe(true);
    expect(hashCompileOperationForLedger({
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body: "Example body.",
    })).toBe(hashCompileOperationForLedger({
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body: "Example body.",
      frontmatter: {},
    }));
  });

  it("recognizes pre-canonical ledger keys without frontmatter", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    // Simulate a vault that resolved the op before frontmatter canonicalization.
    const legacyKey = createHash("sha256")
      .update(JSON.stringify(operation))
      .digest("hex")
      .slice(0, 32);
    const path = resolvedProposalsPath(tmp);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        resolved: {
          [legacyKey]: {
            action: "approved",
            resolvedAt: "2026-06-10T00:00:00.000Z",
            path: "wiki/projects/example.md",
          },
        },
      }, null, 2)}\n`,
    );

    expect(await isProposalResolved(tmp, operation)).toBe(true);
    expect(await isProposalResolved(tmp, {
      ...operation,
      frontmatter: {},
    })).toBe(true);

    // Re-recording migrates the entry onto the canonical key.
    await recordProposalResolved(tmp, { ...operation, frontmatter: {} }, "approved", {
      now: new Date("2026-06-11T00:00:00Z"),
    });
    const ledger = JSON.parse(await readFile(path, "utf-8"));
    expect(ledger.resolved[legacyKey]).toBeUndefined();
    expect(ledger.resolved[hashCompileOperationForLedger(operation)]).toMatchObject({
      action: "approved",
    });
  });

  it("ignores created/updated frontmatter when hashing proposals", async () => {
    await recordProposalResolved(
      tmp,
      {
        kind: "rewrite_page",
        path: "wiki/projects/example.md",
        body: "Example body.",
        frontmatter: {
          type: "projects",
          title: "Example",
          created: "2026-06-10",
          updated: "2026-06-10",
          confidence: 0.4,
        },
      },
      "rejected",
      { now: new Date("2026-06-10T12:00:00Z") },
    );

    // Same proposal restaged a day later after normalizeFrontmatter rewrote dates.
    expect(await isProposalResolved(tmp, {
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body: "Example body.",
      frontmatter: {
        type: "projects",
        title: "Example",
        created: "2026-06-11",
        updated: "2026-06-11",
        confidence: 0.4,
      },
    })).toBe(true);

    expect(hashCompileOperationForLedger({
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body: "Example body.",
      frontmatter: { type: "projects", title: "Example", created: "2026-06-10", updated: "2026-06-10", confidence: 0.4 },
    })).toBe(hashCompileOperationForLedger({
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body: "Example body.",
      frontmatter: { type: "projects", title: "Example", created: "2026-06-11", updated: "2026-06-11", confidence: 0.4 },
    }));
  });

  it("does not mark a different operation as resolved", async () => {
    await recordProposalResolved(tmp, operation, "rejected");
    expect(await isProposalResolved(tmp, { ...operation, body: "Different body." })).toBe(false);
  });

  it("accumulates multiple resolutions", async () => {
    await recordProposalResolved(tmp, operation, "approved");
    await recordProposalResolved(tmp, { ...operation, path: "wiki/tools/other.md" }, "rejected");
    expect(Object.keys(await readResolvedProposals(tmp))).toHaveLength(2);
  });

  it("survives a corrupt ledger file", async () => {
    await recordProposalResolved(tmp, operation, "approved");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolvedProposalsPath(tmp), "not json", "utf-8");
    expect(await isProposalResolved(tmp, operation)).toBe(false);
  });
});
