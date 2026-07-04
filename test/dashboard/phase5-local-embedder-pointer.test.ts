import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPhase5ModelLfsPointer } from "../../src/dashboard/phase5-local-embedder.js";

const LFS_POINTER = [
  "version https://git-lfs.github.com/spec/v1",
  "oid sha256:828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
  "size 133093490",
  "",
].join("\n");

describe("isPhase5ModelLfsPointer", () => {
  let modelRoot: string;

  beforeEach(async () => {
    modelRoot = await mkdtemp(join(tmpdir(), "phase5-lfs-pointer-"));
    await mkdir(join(modelRoot, "onnx"), { recursive: true });
  });

  afterEach(async () => {
    await rm(modelRoot, { recursive: true, force: true });
  });

  it("detects a Git LFS pointer stub", async () => {
    await writeFile(join(modelRoot, "onnx", "model.onnx"), LFS_POINTER, "utf8");
    expect(isPhase5ModelLfsPointer(modelRoot)).toBe(true);
  });

  it("treats real model bytes as not a pointer", async () => {
    await writeFile(join(modelRoot, "onnx", "model.onnx"), Buffer.alloc(4096, 7));
    expect(isPhase5ModelLfsPointer(modelRoot)).toBe(false);
  });

  it("treats a small non-pointer file as not a pointer", async () => {
    await writeFile(join(modelRoot, "onnx", "model.onnx"), "not a pointer", "utf8");
    expect(isPhase5ModelLfsPointer(modelRoot)).toBe(false);
  });

  it("treats a missing model as not a pointer so validation still hard-fails", () => {
    expect(isPhase5ModelLfsPointer(modelRoot)).toBe(false);
  });
});
