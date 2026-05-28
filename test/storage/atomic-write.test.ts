import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename as actualRename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("atomicWrite rename retry", () => {
  let dir: string | null = null;
  let restorePlatform: (() => void) | null = null;

  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    restorePlatform?.();
    restorePlatform = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("retries a transient Windows EPERM rename and records retry success", async () => {
    restorePlatform = stubPlatform("win32");
    dir = await mkdtemp(join(tmpdir(), "memtest-atomic-retry-"));
    let attempts = 0;
    const rename = vi.fn(async (from: string, to: string) => {
      attempts += 1;
      if (attempts === 1) throw errno("EPERM");
      await actualRename(from, to);
    });
    const { atomicWrite, atomicWriteRetryStats } = await loadAtomicWrite(rename);

    await atomicWrite(join(dir, "pending"), "ready");

    expect(await readFile(join(dir, "pending"), "utf-8")).toBe("ready");
    expect(rename).toHaveBeenCalledTimes(2);
    expect(atomicWriteRetryStats).toMatchObject({
      writes: 1,
      success: 1,
      exhausted: 0,
    });
  });

  it("throws the original Windows EPERM after all retries are exhausted", async () => {
    restorePlatform = stubPlatform("win32");
    dir = await mkdtemp(join(tmpdir(), "memtest-atomic-exhausted-"));
    const firstError = errno("EPERM");
    const rename = vi.fn(async () => {
      throw firstError;
    });
    const { atomicWrite, atomicWriteRetryStats } = await loadAtomicWrite(rename);

    await expect(atomicWrite(join(dir, "pending"), "ready")).rejects.toBe(firstError);

    expect(rename).toHaveBeenCalledTimes(4);
    expect(atomicWriteRetryStats).toMatchObject({
      writes: 1,
      success: 0,
      exhausted: 1,
    });
  });

  it("does not retry non-race rename errors", async () => {
    restorePlatform = stubPlatform("win32");
    dir = await mkdtemp(join(tmpdir(), "memtest-atomic-nonrace-"));
    const error = errno("EISDIR");
    const rename = vi.fn(async () => {
      throw error;
    });
    const { atomicWrite, atomicWriteRetryStats } = await loadAtomicWrite(rename);

    await expect(atomicWrite(join(dir, "pending"), "ready")).rejects.toBe(error);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(atomicWriteRetryStats).toMatchObject({
      writes: 1,
      success: 0,
      exhausted: 0,
    });
  });

  it("does not retry transient-looking rename errors on POSIX", async () => {
    restorePlatform = stubPlatform("linux");
    dir = await mkdtemp(join(tmpdir(), "memtest-atomic-posix-"));
    const error = errno("EPERM");
    const rename = vi.fn(async () => {
      throw error;
    });
    const { atomicWrite, atomicWriteRetryStats } = await loadAtomicWrite(rename);

    await expect(atomicWrite(join(dir, "pending"), "ready")).rejects.toBe(error);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(atomicWriteRetryStats).toMatchObject({
      writes: 1,
      success: 0,
      exhausted: 0,
    });
  });
});

async function loadAtomicWrite(rename: (from: string, to: string) => Promise<void>) {
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    return {
      ...actual,
      rename,
    };
  });
  return import("../../src/storage/atomic-write.js");
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function stubPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  return () => {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  };
}
