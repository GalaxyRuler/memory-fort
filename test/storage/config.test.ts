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

  it("loadMemoryConfig parses voyage + vps sections", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "voyage:",
        '  api_key: "test-key-123"',
        "vps:",
        '  host: "srv1317946"',
        '  install_root: "/root/memory-system"',
      ].join("\n"),
    );

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({
      voyage: { api_key: "test-key-123" },
      vps: { host: "srv1317946", install_root: "/root/memory-system" },
    });
  });

  it("loadMemoryConfig tolerates malformed YAML", async () => {
    await writeFile(join(tmp, "config.yaml"), 'voyage:\n  api_key: "unterminated\n');

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({});
  });
});
