import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigPatch,
  validateConfigPatch,
} from "../../src/dashboard/config-patch.js";
import { loadMemoryConfig } from "../../src/storage/config.js";

describe("dashboard config patch", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "config-patch-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "embedder:",
        "  provider: voyage",
        "  model: voyage-4-large",
        "llm:",
        "  provider: ollama",
        "  model: llama3.2",
        "  max_tokens: 2048",
        "  temperature: 0.4",
        "retention:",
        "  raw_window_days: 90",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("accepts safelisted embedder and llm fields", () => {
    expect(validateConfigPatch({
      embedder: { provider: "openai", model: "text-embedding-3-small", options: {} },
      llm: { provider: "openrouter", model: "openai/gpt-4o-mini", max_tokens: 4096, temperature: 0.2 },
      auto_promote: { enabled: true, cadence: "weekly", confidence_threshold: "high" },
      compile: { scheduled: true, cadence: "daily", execute: true },
      dashboard: { trusted_origins: ["https://examplehost.exampletail.ts.net"] },
    })).toEqual({ ok: true, errors: [] });
  });

  it("rejects unsafelisted fields with the offending path", () => {
    const result = validateConfigPatch({ embedder: { api_key: "secret" } });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      path: "embedder.api_key",
      message: "field not in safelist",
    });
  });

  it("rejects invalid provider and tuning values", () => {
    const result = validateConfigPatch({
      embedder: { provider: "bad" },
      llm: { max_tokens: 99999, temperature: 3 },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "embedder.provider" }),
        expect.objectContaining({ path: "llm.max_tokens" }),
        expect.objectContaining({ path: "llm.temperature" }),
      ]),
    );
  });

  it("rejects secret-like keys inside safelisted options objects", () => {
    const result = validateConfigPatch({
      embedder: { options: { api_key: "secret" } },
      llm: { options: { token: "secret" } },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { path: "embedder.options.api_key", message: "API keys and secrets are env-var-only" },
        { path: "llm.options.token", message: "API keys and secrets are env-var-only" },
      ]),
    );
  });

  it("deep-merges safelisted patches, writes a backup, and keeps config readable", async () => {
    const result = await applyConfigPatch(tmp, {
      embedder: { provider: "openai", model: "text-embedding-3-small", options: { baseURL: "http://proxy.test" } },
      llm: { model: "anthropic/claude-3.5-sonnet", temperature: 0.1 },
      dashboard: { trusted_origins: ["https://examplehost.exampletail.ts.net"] },
    });

    expect(result.applied).toEqual([
      "embedder.provider",
      "embedder.model",
      "embedder.options",
      "llm.model",
      "llm.temperature",
      "dashboard.trusted_origins",
    ]);
    await expect(loadMemoryConfig(tmp)).resolves.toMatchObject({
      embedder: {
        provider: "openai",
        model: "text-embedding-3-small",
        options: { baseURL: "http://proxy.test" },
      },
      llm: {
        provider: "ollama",
        model: "anthropic/claude-3.5-sonnet",
        max_tokens: 2048,
        temperature: 0.1,
      },
      dashboard: {
        trusted_origins: ["https://examplehost.exampletail.ts.net"],
      },
      retention: { raw_window_days: 90 },
    });
    const backups = await readdir(join(tmp, ".config-backups"));
    expect(backups).toHaveLength(1);
    await expect(readFile(join(tmp, ".config-backups", backups[0]!), "utf-8")).resolves.toContain("provider: voyage");
  });

  it("leaves the original config intact when the atomic write fails", async () => {
    const original = await readFile(join(tmp, "config.yaml"), "utf-8");

    await expect(applyConfigPatch(tmp, { embedder: { provider: "openai" } }, {
      atomicWrite: async () => {
        throw new Error("disk full");
      },
    })).rejects.toThrow("failed to write config.yaml: disk full");

    await expect(readFile(join(tmp, "config.yaml"), "utf-8")).resolves.toBe(original);
  });

  it("retains only the five newest backups", async () => {
    for (let index = 0; index < 6; index += 1) {
      await applyConfigPatch(tmp, { llm: { max_tokens: 1000 + index } }, {
        now: () => new Date(`2026-05-28T00:00:0${index}.000Z`),
      });
    }

    const backups = (await readdir(join(tmp, ".config-backups"))).sort();
    expect(backups).toHaveLength(5);
    expect(backups[0]).toContain("2026-05-28T00-00-01");
    expect(backups.at(-1)).toContain("2026-05-28T00-00-05");
  });
});
