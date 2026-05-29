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

  it("loadMemoryConfig parses full YAML features with JSON schema dates", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "llm:",
        "  provider: openrouter # inline comment",
        "  model: openai/gpt-4o-mini",
        "  max_tokens: 4096",
        "  temperature: 0.2",
        "  options:",
        "    response_format:",
        "      type: json_object",
        "dashboard:",
        "  trusted_origins: [https://example.test, http://127.0.0.1:4410]",
        "compile:",
        "  scheduled: true",
        "  next_run: 2026-05-29",
      ].join("\n"),
    );

    const config = await loadMemoryConfig(tmp);

    expect(config.llm).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      max_tokens: 4096,
      temperature: 0.2,
      options: {
        response_format: { type: "json_object" },
      },
    });
    expect(config.dashboard?.trusted_origins).toEqual([
      "https://example.test",
      "http://127.0.0.1:4410",
    ]);
    expect(config.compile?.scheduled).toBe(true);
    expect((config.compile as Record<string, unknown>).next_run).toBe("2026-05-29");
  });

  it("loadMemoryConfig tolerates malformed YAML", async () => {
    await writeFile(join(tmp, "config.yaml"), 'voyage:\n  api_key: "unterminated\n');

    await expect(loadMemoryConfig(tmp)).resolves.toEqual({});
  });
});
