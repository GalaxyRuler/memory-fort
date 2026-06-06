import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  memoryRoot,
  schemaPath,
  rawDir,
  rawSessionFile,
  wikiDir,
  formatIsoDate,
} from "../src/storage/paths.js";

describe("paths", () => {
  const ORIG = process.env["MEMORY_ROOT"];
  beforeEach(() => { delete process.env["MEMORY_ROOT"]; });
  afterEach(() => {
    if (ORIG === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = ORIG;
  });

  it("respects MEMORY_ROOT env var", () => {
    process.env["MEMORY_ROOT"] = "C:\\test\\memory";
    expect(memoryRoot()).toBe("C:\\test\\memory");
  });

  it("falls back to ~/.memory when env var unset", () => {
    delete process.env["MEMORY_ROOT"];
    expect(memoryRoot()).toMatch(/\.memory$/);
  });

  it("schemaPath resolves under memoryRoot", () => {
    process.env["MEMORY_ROOT"] = "C:\\test\\memory";
    expect(schemaPath()).toMatch(/schema\.md$/);
  });

  it("rawDir uses ISO 8601 date prefix", () => {
    process.env["MEMORY_ROOT"] = "C:\\test\\memory";
    const d = new Date(Date.UTC(2026, 4, 21));
    expect(rawDir(d)).toMatch(/2026-05-21$/);
  });

  it("rawSessionFile sanitizes session id", () => {
    process.env["MEMORY_ROOT"] = "C:\\test\\memory";
    const d = new Date(Date.UTC(2026, 4, 21));
    const path = rawSessionFile("claude-code", "abc/123:xyz?", d);
    expect(path).toMatch(/claude-code-abc_123_xyz_\.md$/);
  });

  it("wikiDir with category returns category subdir", () => {
    process.env["MEMORY_ROOT"] = "C:\\test\\memory";
    expect(wikiDir("projects")).toMatch(/wiki[\\/]projects$/);
  });

  it("wikiDir without category returns base wiki dir", () => {
    process.env["MEMORY_ROOT"] = "C:\\test\\memory";
    expect(wikiDir()).toMatch(/wiki$/);
  });

  it("formatIsoDate uses UTC, not local time", () => {
    const d = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(formatIsoDate(d)).toBe("2026-12-31");
  });
});
