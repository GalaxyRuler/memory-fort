import { describe, expect, it } from "vitest";
import { createFullCorpusAdmissionGate } from "../../src/dashboard/full-corpus-admission.js";

describe("full-corpus admission gate", () => {
  it("runs one full-corpus job at a time and lets maintenance yield while search is active", async () => {
    const gate = createFullCorpusAdmissionGate();
    let releaseSearch!: () => void;
    const searchStarted = gate.runSearch(async () => {
      await new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      return "search-done";
    });

    await until(() => gate.snapshot().active?.kind === "search");

    const maintenance = await gate.tryRunMaintenance(async () => "maintenance-done");

    expect(maintenance).toEqual({ started: false, reason: "search-active" });
    expect(gate.snapshot()).toMatchObject({
      active: { kind: "search" },
      queuedSearches: 0,
    });

    releaseSearch();
    await expect(searchStarted).resolves.toBe("search-done");
  });

  it("drains a queued search before a queued verify (search priority)", async () => {
    const gate = createFullCorpusAdmissionGate();
    const order: string[] = [];
    let releaseOp1!: () => void;
    const op1 = gate.runVerify(async () => {
      order.push("op1");
      await new Promise<void>((resolve) => {
        releaseOp1 = resolve;
      });
    });

    await until(() => gate.snapshot().active?.kind === "verify");

    const op2 = gate.runVerify(async () => {
      order.push("op2");
      return "verify-done";
    });
    const op3 = gate.runSearch(async () => {
      order.push("op3");
      return "search-done";
    });

    await until(() => gate.snapshot().queuedSearches === 1);
    releaseOp1();
    await Promise.all([op1, op2, op3]);

    expect(order).toEqual(["op1", "op3", "op2"]);
  });

  it("releases the gate when an operation throws", async () => {
    const gate = createFullCorpusAdmissionGate();

    await expect(gate.runSearch(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(gate.snapshot().active).toBeNull();
    await expect(gate.runSearch(async () => "ok")).resolves.toBe("ok");
  });

  it("rejects maintenance as busy when a non-search job is active", async () => {
    const gate = createFullCorpusAdmissionGate();
    let releaseVerify!: () => void;
    const verify = gate.runVerify(async () => {
      await new Promise<void>((resolve) => {
        releaseVerify = resolve;
      });
      return "verify-done";
    });

    await until(() => gate.snapshot().active?.kind === "verify");

    const maintenance = await gate.tryRunMaintenance(async () => "x");

    expect(maintenance).toEqual({ started: false, reason: "busy" });
    releaseVerify();
    await expect(verify).resolves.toBe("verify-done");
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
