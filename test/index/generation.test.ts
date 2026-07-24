import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  beginIndexInvalidation,
  completeIndexInvalidation,
  readIndexGeneration,
} from "../../src/index/generation.js";

describe("index generation ownership", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "index-generation-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prevents a stale invalidation owner from publishing ready over a newer fence", async () => {
    const first = await beginIndexInvalidation(root);
    const second = await beginIndexInvalidation(root);

    await expect(completeIndexInvalidation(root, first.token))
      .rejects.toThrow("index generation ownership changed");
    expect(readIndexGeneration(root)).toEqual(second);

    const ready = await completeIndexInvalidation(root, second.token);
    expect(ready.state).toBe("ready");
    expect(readIndexGeneration(root)).toEqual(ready);
  });
});
