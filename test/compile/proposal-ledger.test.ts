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
