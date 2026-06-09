import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatgptBridgeRunningCheck,
  chatgptBridgeMcpCheck,
} from "../../../../src/cli/commands/verify/chatgpt.js";
import { chatgptBridgePidPath } from "../../../../src/storage/paths.js";

async function makeVault(configYaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mf-chatgpt-"));
  await writeFile(join(root, "config.yaml"), configYaml, "utf-8");
  return root;
}

describe("chatgptBridgeRunningCheck", () => {
  let origLocalAppData: string | undefined;

  beforeEach(async () => {
    origLocalAppData = process.env["LOCALAPPDATA"];
    // Point LOCALAPPDATA to a temp dir so chatgptBridgePidPath() returns a test path
    const tempState = await mkdtemp(join(tmpdir(), "mf-chatgpt-state-"));
    process.env["LOCALAPPDATA"] = tempState;
  });

  afterEach(() => {
    if (origLocalAppData === undefined) {
      delete process.env["LOCALAPPDATA"];
    } else {
      process.env["LOCALAPPDATA"] = origLocalAppData;
    }
  });

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

  it("returns skip when chatgpt client is not mentioned (opt-in)", async () => {
    const vaultRoot = await makeVault("clients:\n  opencoven: false\n");
    const result = await chatgptBridgeRunningCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("skip");
  });

  it("passes when chatgpt is enabled and PID file has live process", async () => {
    const vaultRoot = await makeVault("clients:\n  chatgpt: true\n");
    // Write current process PID to the PID file path (LOCALAPPDATA/memory-fort/) — guaranteed alive
    const pidPath = chatgptBridgePidPath();
    await mkdir(join(pidPath, ".."), { recursive: true });
    await writeFile(pidPath, String(process.pid), "utf-8");
    const result = await chatgptBridgeRunningCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("pass");
  });
});

describe("chatgptBridgeMcpCheck", () => {
  let origAppData: string | undefined;
  let tempCertDir: string;

  beforeEach(async () => {
    origAppData = process.env["APPDATA"];
    tempCertDir = await mkdtemp(join(tmpdir(), "mf-chatgpt-cert-state-"));
    process.env["APPDATA"] = tempCertDir;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (origAppData === undefined) {
      delete process.env["APPDATA"];
    } else {
      process.env["APPDATA"] = origAppData;
    }
    await rm(tempCertDir, { recursive: true, force: true });
  });

  it("returns skip when chatgpt client is disabled", async () => {
    const vaultRoot = await makeVault("clients:\n  chatgpt: false\n");
    const result = await chatgptBridgeMcpCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("skip");
  });

  it("returns skip when chatgpt client is not mentioned (opt-in)", async () => {
    const vaultRoot = await makeVault("clients:\n  opencoven: false\n");
    const result = await chatgptBridgeMcpCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("skip");
  });

  it("fails when chatgpt is enabled and bridge is not reachable", async () => {
    const port = await getFreePort();
    const vaultRoot = await makeVault(`clients:\n  chatgpt: true\nchatgpt:\n  bridge_port: ${port}\n`);
    const result = await chatgptBridgeMcpCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    // bridge is not running in tests so we expect fail (cannot reach)
    expect(flat[0]?.status).toBe("fail");
  });

  it("passes when chatgpt is enabled and bridge responds 200", async () => {
    const vaultRoot = await makeVault("clients:\n  chatgpt: true\n");
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal("fetch", mockFetch);
    const result = await chatgptBridgeMcpCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("pass");
  });
});

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
