import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LONGMEMEVAL_S_SOURCE_URL,
  downloadLongMemEvalDataset,
} from "../../src/eval/longmemeval/download.js";

const upstreamRows = [
  {
    question_id: "q-1",
    question: "What degree did I graduate with?",
    question_type: "single-session-user",
    question_date: "2023/05/30 (Tue) 23:40",
    answer_session_ids: ["answer_280352e9"],
  },
];
const upstreamBody = Buffer.from(JSON.stringify(upstreamRows));
const upstreamHash = createHash("sha256").update(upstreamBody).digest("hex");

describe("downloadLongMemEvalDataset", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "longmemeval-download-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("fetches the canonical dataset, verifies hash, normalizes questions, and writes a manifest", async () => {
    const fetchFn = vi.fn(async () => new Response(upstreamBody)) as unknown as typeof fetch;

    const result = await downloadLongMemEvalDataset({
      cacheDir: tmp,
      fetchFn,
      expectedSha256: upstreamHash,
      now: () => new Date("2026-05-26T01:30:00.000Z"),
    });

    expect(fetchFn).toHaveBeenCalledWith(LONGMEMEVAL_S_SOURCE_URL);
    expect(result.status).toBe("downloaded");
    const questions = await readFile(join(tmp, "longmemeval-s", "questions.jsonl"), "utf-8");
    expect(questions.trim()).toBe(JSON.stringify({
      question_id: "q-1",
      question: "What degree did I graduate with?",
      expected_evidence_ids: ["answer_280352e9"],
      category: "single-session-user",
      timestamp: "2023/05/30 (Tue) 23:40",
    }));

    const manifest = JSON.parse(
      await readFile(join(tmp, "longmemeval-s", "manifest.json"), "utf-8"),
    );
    expect(manifest).toMatchObject({
      dataset: "longmemeval-s",
      sha256: upstreamHash,
      sourceUrl: LONGMEMEVAL_S_SOURCE_URL,
      downloadedAt: "2026-05-26T01:30:00.000Z",
      questionCount: 1,
    });
  });

  it("skips the network when the manifest and normalized file already match", async () => {
    const fetchFn = vi.fn(async () => new Response(upstreamBody)) as unknown as typeof fetch;
    await downloadLongMemEvalDataset({
      cacheDir: tmp,
      fetchFn,
      expectedSha256: upstreamHash,
    });

    const secondFetch = vi.fn() as unknown as typeof fetch;
    const second = await downloadLongMemEvalDataset({
      cacheDir: tmp,
      fetchFn: secondFetch,
      expectedSha256: upstreamHash,
    });

    expect(second.status).toBe("skipped");
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("deletes partial files and exits 1 when the downloaded hash does not match", async () => {
    const fetchFn = vi.fn(async () => new Response(Buffer.from("corrupt"))) as unknown as typeof fetch;

    await expect(downloadLongMemEvalDataset({
      cacheDir: tmp,
      fetchFn,
      expectedSha256: upstreamHash,
    })).rejects.toMatchObject({ exitCode: 1 });

    expect(existsSync(join(tmp, "longmemeval-s", "questions.jsonl"))).toBe(false);
    expect(existsSync(join(tmp, "longmemeval-s", "manifest.json"))).toBe(false);
  });
});
