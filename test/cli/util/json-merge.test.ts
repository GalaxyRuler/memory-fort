import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeJsonFile } from "../../../src/cli/util/json-merge.js";

describe("mergeJsonFile", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "merge-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates file when missing", async () => {
    const path = join(tmp, "config.json");
    const result = await mergeJsonFile(path, { foo: "bar" });
    expect(result.created).toBe(true);
    const content = JSON.parse(await readFile(path, "utf-8"));
    expect(content).toEqual({ foo: "bar" });
  });

  it("preserves other top-level keys", async () => {
    const path = join(tmp, "config.json");
    await writeFile(
      path,
      JSON.stringify({ other: "kept", mcpServers: { existing: {} } }),
    );
    await mergeJsonFile(path, { mcpServers: { added: { x: 1 } } });
    const content = JSON.parse(await readFile(path, "utf-8"));
    expect(content.other).toBe("kept");
    expect(content.mcpServers.existing).toBeDefined();
    expect(content.mcpServers.added).toEqual({ x: 1 });
  });

  it("deep merges nested objects", async () => {
    const path = join(tmp, "config.json");
    await writeFile(path, JSON.stringify({ a: { b: { c: 1, d: 2 } } }));
    await mergeJsonFile(path, { a: { b: { c: 99 } } });
    const content = JSON.parse(await readFile(path, "utf-8"));
    expect(content.a.b.c).toBe(99);
    expect(content.a.b.d).toBe(2);
  });

  it("malformed JSON is treated as empty", async () => {
    const path = join(tmp, "config.json");
    await writeFile(path, "not json {");
    await mergeJsonFile(path, { foo: "bar" });
    const content = JSON.parse(await readFile(path, "utf-8"));
    expect(content).toEqual({ foo: "bar" });
  });
});
