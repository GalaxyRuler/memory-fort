import { describe, expect, it } from "vitest";
import { runVerify, type CheckDescriptor } from "../../../../src/cli/commands/verify.js";

describe("deep verify context", () => {
  it("passes deep mode to descriptor checks", async () => {
    const seen: Array<boolean | undefined> = [];

    await runVerify({
      deep: true,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      checkDescriptors: [{
        id: "capture-deep",
        label: "capture deep",
        roles: ["operator"],
        async run(opts) {
          seen.push(opts.deep);
          return { id: "capture-deep", label: "capture deep", status: "pass", durationMs: 0 };
        },
      }],
    });

    expect(seen).toEqual([true]);
  });

  it("uses a descriptor's longer timeout only in deep mode", async () => {
    const descriptor = {
      id: "deep-timeout",
      label: "deep timeout",
      roles: ["operator"],
      timeoutMs: 1,
      deepTimeoutMs: 100,
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { id: "deep-timeout", label: "deep timeout", status: "pass", durationMs: 0 } as const;
      },
    } satisfies CheckDescriptor;

    const result = await runVerify({
      deep: true,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      checkDescriptors: [descriptor],
    });

    expect(result.checks[0]?.status).toBe("pass");
  });
});
