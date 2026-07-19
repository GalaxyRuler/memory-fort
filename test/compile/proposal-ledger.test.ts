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

  it("matches and migrates legacy map keys that included created/updated", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const day1 = {
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
    };
    const day2 = {
      ...day1,
      frontmatter: {
        ...day1.frontmatter,
        created: "2026-06-11",
        updated: "2026-06-11",
      },
    };
    const legacyDatedKey = createHash("sha256")
      .update(JSON.stringify(day1))
      .digest("hex")
      .slice(0, 32);
    const path = resolvedProposalsPath(tmp);
    await mkdir(dirname(path), { recursive: true });
    // Pre-volatile-strip ledger: map key is the dated raw hash only.
    await writeFile(
      path,
      `${JSON.stringify({
        resolved: {
          [legacyDatedKey]: {
            action: "rejected",
            resolvedAt: "2026-06-10T12:00:00.000Z",
            path: "wiki/projects/example.md",
          },
        },
      }, null, 2)}\n`,
    );

    // Same-day restage still finds the dated key, then migrates to stableKey.
    expect(await isProposalResolved(tmp, day1)).toBe(true);
    let ledger = JSON.parse(await readFile(path, "utf-8"));
    expect(ledger.resolved[legacyDatedKey]).toBeUndefined();
    expect(ledger.resolved[hashCompileOperationForLedger(day1)]).toMatchObject({
      action: "rejected",
      stableKey: hashCompileOperationForLedger(day1),
    });

    // After migration, a day-boundary restage matches via stableKey / canonical.
    expect(await isProposalResolved(tmp, day2)).toBe(true);
    ledger = JSON.parse(await readFile(path, "utf-8"));
    expect(ledger.resolved[hashCompileOperationForLedger(day2)]).toMatchObject({
      action: "rejected",
    });
  });

  it("matches legacy entries that only store stableKey under an old map key", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const day2 = {
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
    };
    const stable = hashCompileOperationForLedger(day2);
    const orphanKey = createHash("sha256").update("orphan-legacy-key").digest("hex").slice(0, 32);
    const path = resolvedProposalsPath(tmp);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        resolved: {
          [orphanKey]: {
            action: "approved",
            resolvedAt: "2026-06-10T12:00:00.000Z",
            stableKey: stable,
          },
        },
      }, null, 2)}\n`,
    );

    expect(await isProposalResolved(tmp, day2)).toBe(true);
    const ledger = JSON.parse(await readFile(path, "utf-8"));
    expect(ledger.resolved[orphanKey]).toBeUndefined();
    expect(ledger.resolved[stable]).toMatchObject({ action: "approved", stableKey: stable });
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

  it("does not match review-keyed ops to unkeyed legacy body-only entries", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const body = "Unchanged page body.";
    const unkeyed = {
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body,
    };
    const legacyKey = createHash("sha256")
      .update(JSON.stringify(unkeyed))
      .digest("hex")
      .slice(0, 32);
    const path = resolvedProposalsPath(tmp);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        resolved: {
          [legacyKey]: {
            action: "rejected",
            resolvedAt: "2026-06-10T12:00:00.000Z",
          },
        },
      }, null, 2)}\n`,
    );

    const keyed = {
      kind: "rewrite_page",
      path: "wiki/projects/example.md",
      body,
      frontmatter: {
        narrative_review_key: "distinct-claims-fingerprint",
      },
    };
    // Distinct safety-gate review must not be suppressed by the unkeyed legacy entry.
    expect(await isProposalResolved(tmp, keyed)).toBe(false);
    // The original unkeyed shape still resolves.
    expect(await isProposalResolved(tmp, unkeyed)).toBe(true);
  });

  it("serializes concurrent recordProposalResolved so both entries survive", async () => {
    const opA = {
      kind: "rewrite_page",
      path: "wiki/projects/a.md",
      body: "Body A.",
    };
    const opB = {
      kind: "rewrite_page",
      path: "wiki/projects/b.md",
      body: "Body B.",
    };

    await Promise.all([
      recordProposalResolved(tmp, opA, "approved", { path: "wiki/projects/a.md" }),
      recordProposalResolved(tmp, opB, "rejected", { path: "wiki/projects/b.md" }),
    ]);

    const ledger = await readResolvedProposals(tmp);
    expect(Object.keys(ledger)).toHaveLength(2);
    expect(await isProposalResolved(tmp, opA)).toBe(true);
    expect(await isProposalResolved(tmp, opB)).toBe(true);
  });
});
