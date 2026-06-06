import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSymlinkOrJunction } from "../../../src/cli/util/symlink-or-junction.js";

describe("ensureSymlinkOrJunction", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "link-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates link to target directory", async () => {
    const target = join(tmp, "target");
    const link = join(tmp, "link");
    await mkdir(target);
    await writeFile(join(target, "marker.txt"), "x");
    const result = await ensureSymlinkOrJunction(target, link);
    expect(result).toBe("created");
    expect(existsSync(join(link, "marker.txt"))).toBe(true);
  });

  it("returns exists on second invocation without force", async () => {
    const target = join(tmp, "target");
    const link = join(tmp, "link");
    await mkdir(target);
    await ensureSymlinkOrJunction(target, link);
    const result = await ensureSymlinkOrJunction(target, link);
    expect(result).toBe("exists");
  });

  it("throws when existing link points elsewhere without force", async () => {
    const first = join(tmp, "first");
    const second = join(tmp, "second");
    const link = join(tmp, "link");
    await mkdir(first);
    await mkdir(second);
    await ensureSymlinkOrJunction(first, link);
    await expect(ensureSymlinkOrJunction(second, link)).rejects.toThrow(
      /points elsewhere/,
    );
  });
});
