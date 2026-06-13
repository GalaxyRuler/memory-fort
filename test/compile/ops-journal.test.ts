import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearOpsJournal,
  operationKey,
  opsJournalPath,
  readAppliedOperationKeys,
  recordAppliedOperation,
} from "../../src/compile/ops-journal.js";
import { applyCompileOperations, type CompileOperation } from "../../src/compile/execute.js";

describe("ops journal", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ops-journal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts empty", async () => {
    expect((await readAppliedOperationKeys(root)).size).toBe(0);
  });

  it("records applied operations and reads back their keys", async () => {
    const op = { kind: "append_log", line: "did a thing" } as CompileOperation;
    const other = { kind: "append_log", line: "did another thing" } as CompileOperation;
    await recordAppliedOperation(root, op);
    const keys = await readAppliedOperationKeys(root);
    expect(keys.has(operationKey(op))).toBe(true);
    expect(keys.has(operationKey(other))).toBe(false);
  });

  it("operationKey is stable for identical ops and distinct for different ops", () => {
    const op = { kind: "append_log", line: "did a thing" } as CompileOperation;
    const other = { kind: "append_log", line: "did another thing" } as CompileOperation;
    expect(operationKey(op)).toBe(operationKey({ ...op }));
    expect(operationKey(op)).not.toBe(operationKey(other));
  });

  it("clearOpsJournal removes the journal", async () => {
    const op = { kind: "append_log", line: "did a thing" } as CompileOperation;
    await recordAppliedOperation(root, op);
    await clearOpsJournal(root);
    expect(existsSync(opsJournalPath(root))).toBe(false);
    expect((await readAppliedOperationKeys(root)).size).toBe(0);
  });

  it("skips malformed journal lines instead of throwing", async () => {
    const op = { kind: "append_log", line: "did a thing" } as CompileOperation;
    await recordAppliedOperation(root, op);
    const { atomicAppend } = await import("../../src/storage/atomic-write.js");
    await atomicAppend(opsJournalPath(root), "{broken\n");
    const keys = await readAppliedOperationKeys(root);
    expect(keys.has(operationKey(op))).toBe(true);
  });
});

describe("applyCompileOperations with journal", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ops-journal-apply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips operations already recorded in the journal on a second run", async () => {
    const op: CompileOperation = { kind: "append_log", line: "journal-test marker 7f3a" };
    const first = await applyCompileOperations({
      vaultRoot: root,
      operations: [op],
      journal: true,
    });
    expect(first.applied).toHaveLength(1);
    expect(first.outcomes[0]?.outcome).toBe("log-appended");

    const second = await applyCompileOperations({
      vaultRoot: root,
      operations: [op],
      journal: true,
    });
    expect(second.outcomes.some((o) => o.outcome === "skipped: already applied")).toBe(true);

    const logPath = join(root, "log.md");
    const content = await readFile(logPath, "utf-8");
    expect(content.split("journal-test marker 7f3a").length - 1).toBe(1);
  });

  it("does not journal when journal option is false", async () => {
    const op: CompileOperation = { kind: "append_log", line: "no-journal marker 9b2c" };
    await applyCompileOperations({ vaultRoot: root, operations: [op] });
    const keys = await readAppliedOperationKeys(root);
    expect(keys.size).toBe(0);
  });
});
