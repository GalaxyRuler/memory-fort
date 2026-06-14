import { describe, expect, it } from "vitest";
import { parseMemoryConfigYaml, resolveCompileConfig, validateMemoryConfig } from "../../src/storage/config.js";

describe("compile config knobs", () => {
  it("defaults preserve behavior", () => {
    const c = resolveCompileConfig(parseMemoryConfigYaml("", "config.yaml").compile);
    expect(c.raw_filter).toBe(false);
    expect(c.raw_filter_min_signal_bytes).toBe(40);
    expect(c.drain).toBe(false);
    expect(c.max_passes_per_run).toBe(25);
    expect(c.condensed_index).toBe(true);
    expect(c.index_desc_chars).toBe(50);
    expect(c.index_max_bytes).toBe(32_000);
  });

  it("parses overrides", () => {
    const yaml = [
      "compile:",
      "  raw_filter: true",
      "  drain: true",
      "  max_passes_per_run: 100",
      "  condensed_index: false",
      "  index_desc_chars: 80",
      "  index_max_bytes: 16000",
      "",
    ].join("\n");
    const c = resolveCompileConfig(parseMemoryConfigYaml(yaml, "config.yaml").compile);
    expect(c.raw_filter).toBe(true);
    expect(c.drain).toBe(true);
    expect(c.max_passes_per_run).toBe(100);
    expect(c.condensed_index).toBe(false);
    expect(c.index_desc_chars).toBe(80);
    expect(c.index_max_bytes).toBe(16_000);
  });

  it("validates condensed index knob ranges", () => {
    const config = parseMemoryConfigYaml(
      [
        "compile:",
        "  condensed_index: nope",
        "  index_desc_chars: -1",
        "  index_max_bytes: 9999999",
        "",
      ].join("\n"),
      "config.yaml",
    );

    expect(validateMemoryConfig(config)).toEqual(expect.arrayContaining([
      "compile.condensed_index must be a boolean",
      "compile.index_desc_chars must be an integer between 0 and 1000",
      "compile.index_max_bytes must be an integer between 1000 and 1000000",
    ]));
  });
});
