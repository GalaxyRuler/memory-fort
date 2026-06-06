import { describe, expect, it } from "vitest";
import { ALL_CHECKS } from "../../../../src/cli/commands/verify/registry.js";
import type { VerifyRole } from "../../../../src/cli/commands/verify/types.js";

const EXPECTED_ROLES = new Map<string, VerifyRole[]>([
  ["vault.read-write", ["operator", "server"]],
  ["config.valid", ["operator", "server"]],
  ["dashboard.status", ["operator", "server"]],
  ["search.pipeline", ["operator", "server"]],
  ["episodic.relations.coverage", ["operator", "server"]],
  ["freshness.staleness", ["operator", "server"]],
  ["prospective.overdue", ["operator", "server"]],
  ["graph.cohesion", ["operator", "server"]],
  ["retrieval.embedding-health", ["operator", "server"]],
  ["retrieval.intent-classifier-health", ["operator", "server"]],
  ["frontmatter.source", ["operator", "server"]],
  ["storage.atomic-write-retries", ["operator", "server"]],
  ["compile.recent", ["operator", "server"]],
  ["compile.execute-health", ["operator", "server"]],
  ["prompt.drift", ["operator", "server"]],
  ["curation.content-loss", ["operator", "server"]],
  ["autopush.errors", ["operator"]],
  ["sync.uncommitted-vault", ["operator"]],
  ["git.remote", ["operator"]],
  ["client.claude-code.enabled", ["operator"]],
  ["client.claude-code.hooks", ["operator"]],
  ["client.claude-code.capture", ["operator"]],
  ["sniffer.claude-code.backfill", ["operator"]],
  ["client.codex.config", ["operator"]],
  ["client.codex.capture", ["operator"]],
  ["client.antigravity.config", ["operator"]],
  ["sniffer.antigravity.plugin", ["operator"]],
  ["client.antigravity.capture", ["operator"]],
  ["client.opencoven.readiness", ["operator"]],
  ["client.vscode.config", ["operator"]],
  ["sniffer.vscode.extension", ["operator"]],
  ["sniffer.vscode.capture", ["operator"]],
  ["client.claude-desktop.config", ["operator"]],
  ["sniffer.claude-desktop.watcher", ["operator"]],
  ["sniffer.claude-desktop.capture", ["operator"]],
]);

describe("verify check registry", () => {
  it("contains every role-aware descriptor exactly once", () => {
    const ids = ALL_CHECKS.map((check) => check.id);

    expect(ids).toEqual([...EXPECTED_ROLES.keys()]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares metadata and roles for every descriptor", () => {
    for (const check of ALL_CHECKS) {
      expect(check.id).toEqual(expect.any(String));
      expect(check.id.length).toBeGreaterThan(0);
      expect(check.label).toEqual(expect.any(String));
      expect(check.label.length).toBeGreaterThan(0);
      expect(check.roles).toEqual(EXPECTED_ROLES.get(check.id));
      expect(check.roles.length).toBeGreaterThan(0);
      expect(check.run).toEqual(expect.any(Function));
    }
  });
});
