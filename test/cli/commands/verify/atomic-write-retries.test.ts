import { describe, expect, it } from "vitest";
import { atomicWriteRetryStats } from "../../../../src/storage/atomic-write.js";
import { checkAtomicWriteRetries } from "../../../../src/cli/commands/verify/atomic-write-retries.js";

describe("checkAtomicWriteRetries", () => {
  it("passes when fewer than 1% of writes needed rename retry", async () => {
    setStats({ writes: 200, success: 1, exhausted: 0 });

    const result = await checkAtomicWriteRetries();

    expect(result).toMatchObject({
      id: "storage.atomic-write-retries",
      status: "pass",
      detail: "1/200 writes retried (0.50%); 0 exhausted",
    });
  });

  it("warns when 1% to under 10% of writes needed rename retry", async () => {
    setStats({ writes: 100, success: 5, exhausted: 0 });

    const result = await checkAtomicWriteRetries();

    expect(result).toMatchObject({
      id: "storage.atomic-write-retries",
      status: "warn",
      detail: "5/100 writes retried (5.00%); 0 exhausted",
    });
  });

  it("fails when at least 10% of writes needed retry or exhausted", async () => {
    setStats({ writes: 20, success: 1, exhausted: 1 });

    const result = await checkAtomicWriteRetries();

    expect(result).toMatchObject({
      id: "storage.atomic-write-retries",
      status: "fail",
      detail: "2/20 writes retried (10.00%); 1 exhausted",
    });
  });
});

function setStats(next: { writes: number; success: number; exhausted: number }): void {
  atomicWriteRetryStats.writes = next.writes;
  atomicWriteRetryStats.success = next.success;
  atomicWriteRetryStats.exhausted = next.exhausted;
}
