import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chatgptBridgeRunningCheck,
  chatgptBridgeMcpCheck,
} from "../../../../src/cli/commands/verify/chatgpt.js";

async function makeVault(configYaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mf-chatgpt-"));
  await writeFile(join(root, "config.yaml"), configYaml, "utf-8");
  return root;
}

describe("chatgptBridgeRunningCheck", () => {
  it("fails when chatgpt is enabled and PID file is absent", async () => {
    const vaultRoot = await makeVault("clients:\n  chatgpt: true\n");
    const result = await chatgptBridgeRunningCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("fail");
  });

  it("returns skip when chatgpt client is disabled", async () => {
    const vaultRoot = await makeVault("clients:\n  chatgpt: false\n");
    const result = await chatgptBridgeRunningCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("skip");
  });
});

describe("chatgptBridgeMcpCheck", () => {
  it("returns skip when chatgpt client is disabled", async () => {
    const vaultRoot = await makeVault("clients:\n  chatgpt: false\n");
    const result = await chatgptBridgeMcpCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("skip");
  });

  it("fails when chatgpt is enabled and bridge is not reachable", async () => {
    const vaultRoot = await makeVault("clients:\n  chatgpt: true\n");
    const result = await chatgptBridgeMcpCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    // bridge is not running in tests so we expect fail (cannot reach)
    expect(flat[0]?.status).toBe("fail");
  });
});
