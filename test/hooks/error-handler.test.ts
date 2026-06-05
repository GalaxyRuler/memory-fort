import { describe, it, expect } from "vitest";
import {
  runHook,
  isSdkChildContext,
  type HookContext,
} from "../../src/hooks/error-handler.js";

function makeCtx(overrides: Partial<HookContext> = {}): {
  ctx: HookContext;
  appendedErrors: string[];
  exitCodes: number[];
} {
  const appendedErrors: string[] = [];
  const exitCodes: number[] = [];
  const ctx: HookContext = {
    hookName: "test-hook",
    body: async () => {},
    readStdin: async () => "{}",
    appendError: async (text) => {
      appendedErrors.push(text);
    },
    exit: (code) => {
      exitCodes.push(code);
    },
    now: () => new Date("2026-05-21T12:34:56Z"),
    ...overrides,
  };
  return { ctx, appendedErrors, exitCodes };
}

describe("runHook", () => {
  it("runs body on valid payload and exits 0", async () => {
    let bodyCalled = false;
    const { ctx, exitCodes, appendedErrors } = makeCtx({
      body: async () => {
        bodyCalled = true;
      },
      readStdin: async () => JSON.stringify({ session_id: "abc" }),
    });
    await runHook(ctx);
    expect(bodyCalled).toBe(true);
    expect(exitCodes).toEqual([0]);
    expect(appendedErrors).toEqual([]);
  });

  it("accepts UTF-8 BOM-prefixed JSON payloads", async () => {
    let capturedSessionId: string | undefined;
    const { ctx, exitCodes, appendedErrors } = makeCtx({
      body: async (payload) => {
        capturedSessionId = payload.session_id;
      },
      readStdin: async () => `\uFEFF${JSON.stringify({ session_id: "abc" })}`,
    });
    await runHook(ctx);
    expect(capturedSessionId).toBe("abc");
    expect(exitCodes).toEqual([0]);
    expect(appendedErrors).toEqual([]);
  });

  it("body throwing -> error written to log, exits 0", async () => {
    const { ctx, exitCodes, appendedErrors } = makeCtx({
      body: async () => {
        throw new Error("boom");
      },
    });
    await runHook(ctx);
    expect(exitCodes).toEqual([0]);
    expect(appendedErrors.length).toBe(1);
    expect(appendedErrors[0]).toContain("test-hook");
    expect(appendedErrors[0]).toContain("boom");
    expect(appendedErrors[0]).toContain("2026-05-21T12:34:56");
  });

  it("malformed JSON on stdin writes a diagnostic and exits 0", async () => {
    const { ctx, exitCodes, appendedErrors } = makeCtx({
      readStdin: async () => "not valid json {",
    });
    await runHook(ctx);
    expect(exitCodes).toEqual([0]);
    expect(appendedErrors.length).toBe(1);
    expect(appendedErrors[0]).toContain("stdin-parse-failed");
    expect(appendedErrors[0]).toContain("not valid json {");
  });

  it("malformed JSON from SDK child env still skips silently", async () => {
    const ORIG = process.env["MEMORY_SDK_CHILD"];
    process.env["MEMORY_SDK_CHILD"] = "1";
    try {
      const { ctx, exitCodes, appendedErrors } = makeCtx({
        readStdin: async () => "not valid json {",
      });
      await runHook(ctx);
      expect(exitCodes).toEqual([0]);
      expect(appendedErrors).toEqual([]);
    } finally {
      if (ORIG === undefined) delete process.env["MEMORY_SDK_CHILD"];
      else process.env["MEMORY_SDK_CHILD"] = ORIG;
    }
  });

  it("SDK child context (env var) -> skip body, exit 0", async () => {
    const ORIG = process.env["MEMORY_SDK_CHILD"];
    process.env["MEMORY_SDK_CHILD"] = "1";
    try {
      let bodyCalled = false;
      const { ctx, exitCodes } = makeCtx({
        body: async () => {
          bodyCalled = true;
        },
      });
      await runHook(ctx);
      expect(bodyCalled).toBe(false);
      expect(exitCodes).toEqual([0]);
    } finally {
      if (ORIG === undefined) delete process.env["MEMORY_SDK_CHILD"];
      else process.env["MEMORY_SDK_CHILD"] = ORIG;
    }
  });

  it("SDK child context (payload entrypoint) -> skip body", async () => {
    let bodyCalled = false;
    const { ctx } = makeCtx({
      readStdin: async () =>
        JSON.stringify({ entrypoint: "sdk-ts" }),
      body: async () => {
        bodyCalled = true;
      },
    });
    await runHook(ctx);
    expect(bodyCalled).toBe(false);
  });

  it("appendError throwing does NOT propagate", async () => {
    const { ctx, exitCodes } = makeCtx({
      body: async () => {
        throw new Error("primary failure");
      },
      appendError: async () => {
        throw new Error("secondary errors.log write failure");
      },
    });
    // Should not throw - must exit cleanly
    await expect(runHook(ctx)).resolves.toBeUndefined();
    expect(exitCodes).toEqual([0]);
  });

  it("error log line includes ISO timestamp + hook name", async () => {
    const { ctx, appendedErrors } = makeCtx({
      body: async () => {
        throw new Error("specific message");
      },
    });
    await runHook(ctx);
    const line = appendedErrors[0]!;
    expect(line).toMatch(/^2026-05-21T12:34:56\.000Z test-hook /);
    expect(line).toContain("specific message");
    expect(line.endsWith("\n\n")).toBe(true);
  });
});

describe("isSdkChildContext", () => {
  it("returns true when MEMORY_SDK_CHILD=1", () => {
    const ORIG = process.env["MEMORY_SDK_CHILD"];
    process.env["MEMORY_SDK_CHILD"] = "1";
    try {
      expect(isSdkChildContext({})).toBe(true);
    } finally {
      if (ORIG === undefined) delete process.env["MEMORY_SDK_CHILD"];
      else process.env["MEMORY_SDK_CHILD"] = ORIG;
    }
  });

  it("returns true on payload.entrypoint = sdk-ts", () => {
    expect(isSdkChildContext({ entrypoint: "sdk-ts" })).toBe(true);
  });

  it("returns true on payload.entrypoint = memory-mcp", () => {
    expect(isSdkChildContext({ entrypoint: "memory-mcp" })).toBe(true);
  });

  it("returns false on a regular payload", () => {
    delete process.env["MEMORY_SDK_CHILD"];
    expect(isSdkChildContext({ session_id: "abc" })).toBe(false);
  });
});
