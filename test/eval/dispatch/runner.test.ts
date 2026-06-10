import { describe, it, expect } from "vitest";
import { runDispatchPolicyEval } from "../../../src/eval/dispatch/runner.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";

describe("runDispatchPolicyEval", () => {
  it("achieves >= 70% accuracy on the bundled gold file", async () => {
    const goldPath = join(process.cwd(), "qa", "dispatch-gold.jsonl");
    const report = await runDispatchPolicyEval({ goldPath });
    expect(report.total).toBeGreaterThan(0);
    expect(report.accuracy).toBeGreaterThanOrEqual(0.7);
  });

  it("returns correct=true for a clear supersession", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mf-dispatch-"));
    const gold = join(tmp, "gold.jsonl");
    await writeFile(gold, JSON.stringify({
      scenario: "supersession test",
      type: "supersession",
      raw_content: "The project now uses TypeScript 5.5",
      existing_page: "wiki/tools/typescript.md",
      existing_body: "Project uses TypeScript 5.4",
      expected_op: "supersede_page",
    }) + "\n");
    const report = await runDispatchPolicyEval({ goldPath: gold });
    expect(report.results[0]!.correct).toBe(true);
  });

  it("returns correct=true for a novel entry (no existing page)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mf-dispatch-novel-"));
    const gold = join(tmp, "gold.jsonl");
    await writeFile(gold, JSON.stringify({
      scenario: "novel test",
      type: "novel",
      raw_content: "Started using Bun as a JS runtime",
      expected_op: "write_page",
    }) + "\n");
    const report = await runDispatchPolicyEval({ goldPath: gold });
    expect(report.results[0]!.correct).toBe(true);
  });

  it("honors explicit conflict_type override", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mf-dispatch-override-"));
    const gold = join(tmp, "gold.jsonl");
    await writeFile(gold, JSON.stringify({
      scenario: "update override",
      type: "duplicate",
      raw_content: "RRF supports configurable K",
      existing_page: "wiki/concepts/rrf.md",
      existing_body: "RRF fuses with K=60",
      conflict_type: "update",
      expected_op: "rewrite_page",
    }) + "\n");
    const report = await runDispatchPolicyEval({ goldPath: gold });
    expect(report.results[0]!.correct).toBe(true);
  });

  it("aggregates byType accuracy", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mf-dispatch-agg-"));
    const gold = join(tmp, "gold.jsonl");
    const rows = [
      { scenario: "a", type: "noop", raw_content: "x", existing_page: "wiki/a.md", expected_op: "noop" },
      { scenario: "b", type: "contradiction", raw_content: "y", existing_page: "wiki/b.md", expected_op: "dispute_page" },
    ];
    await writeFile(gold, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const report = await runDispatchPolicyEval({ goldPath: gold });
    expect(report.total).toBe(2);
    expect(report.byType["noop"]!.accuracy).toBe(1);
    expect(report.byType["contradiction"]!.accuracy).toBe(1);
  });
});
