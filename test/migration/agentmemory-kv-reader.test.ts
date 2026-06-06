import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAgentMemoryValue,
  readAgentMemoryKvStore,
} from "../../src/migration/agentmemory-kv-reader.js";

describe("agentmemory kv reader", () => {
  let tmp: string;
  let stateDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentmemory-kv-"));
    stateDir = join(tmp, "state_store.db");
    await mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("decodes JSON values that have iii-engine trailing bytes", () => {
    const decoded = decodeAgentMemoryValue(
      Buffer.concat([
        Buffer.from('{"a":{"title":"One"}}', "utf-8"),
        Buffer.from([0, 0, 0x82, 0x07]),
      ]),
    );
    expect(decoded).toEqual({ a: { title: "One" } });
  });

  it("reads percent-encoded scope filenames and yields entry keys", async () => {
    await writeFile(
      join(stateDir, "mem%3Aobs%3Asession-1.bin"),
      Buffer.concat([
        Buffer.from(
          JSON.stringify({
            obs_1: { id: "obs_1", title: "First observation" },
            obs_2: { id: "obs_2", title: "Second observation" },
          }),
          "utf-8",
        ),
        Buffer.from([0, 1, 2]),
      ]),
    );

    const entries = await readAgentMemoryKvStore(stateDir);
    expect(entries.map((entry) => entry.scope)).toEqual([
      "mem:obs:session-1",
      "mem:obs:session-1",
    ]);
    expect(entries.map((entry) => entry.entryKey)).toEqual(["obs_1", "obs_2"]);
    expect(entries[0]!.key).toBe("mem:obs:session-1:obs_1");
  });
});
