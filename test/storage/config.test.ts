import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryConfig } from "../../src/storage/config.js";

describe("memory config reader", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-config-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("loadMemoryConfig returns empty when config.yaml missing", async () => {
    await expect(loadMemoryConfig(tmp)).resolves.toEqual({});
  });

  it("loadMemoryConfig parses provider + vps sections without a config API key slot", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        '  provider: "voyage"',
        '  model: "voyage-4-large"',
        "vps:",
        '  host: "srv1317946"',
        '  install_root: "/root/memory-system"',
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      embedder: { provider: "voyage", model: "voyage-4-large" },
      vps: { host: "srv1317946", install_root: "/root/memory-system" },
    });
  });

  it("loadMemoryConfig parses dashboard trusted origins from block lists", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "dashboard:",
        "  trusted_origins:",
        "    - https://srv1317946.tail6916d8.ts.net",
        "    - http://127.0.0.1:4410",
        "",
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      dashboard: {
        trusted_origins: [
          "https://srv1317946.tail6916d8.ts.net",
          "http://127.0.0.1:4410",
        ],
      },
    });
  });

  it("loadMemoryConfig tolerates malformed YAML", async () => {
    await writeFile(join(tmp, "config.yaml"), 'voyage:\n  api_key: "unterminated\n');

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({});
  });
});
