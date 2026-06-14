import { describe, expect, it } from "vitest";
import { parseMemoryConfigYaml, resolveCompileConfig } from "../../src/storage/config.js";

describe("compile config knobs", () => {
  it("defaults preserve behavior", () => {
    const c = resolveCompileConfig(parseMemoryConfigYaml("", "config.yaml").compile);
    expect(c.raw_filter).toBe(false);
    expect(c.raw_filter_min_signal_bytes).toBe(40);
    expect(c.drain).toBe(false);
    expect(c.max_passes_per_run).toBe(25);
  });

  it("parses overrides", () => {
    const yaml = "compile:\n  raw_filter: true\n  drain: true\n  max_passes_per_run: 100\n";
    const c = resolveCompileConfig(parseMemoryConfigYaml(yaml, "config.yaml").compile);
    expect(c.raw_filter).toBe(true);
    expect(c.drain).toBe(true);
    expect(c.max_passes_per_run).toBe(100);
  });
});
