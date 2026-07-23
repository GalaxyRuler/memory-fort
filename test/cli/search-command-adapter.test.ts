import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runSearchMock = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
})));

vi.mock("../../src/cli/commands/search.js", () => ({
  runSearch: runSearchMock,
}));

vi.mock("../../src/storage/secrets.js", () => ({
  loadSecretsIntoEnv: vi.fn(),
}));

vi.mock("../../src/cli/debug-banner.js", () => ({
  printDebugLogBanner: vi.fn(),
}));

describe("Commander search adapter", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
    runSearchMock.mockClear();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("omits noRerank when --no-rerank was not explicitly selected", async () => {
    process.argv = [
      "node",
      "cli.mjs",
      "search",
      "needle",
      "--dashboard-url",
      "http://127.0.0.1:4410/memory",
    ];

    await import("../../src/cli.js");

    expect(runSearchMock).toHaveBeenCalledOnce();
    expect(runSearchMock.mock.calls[0]?.[1]).not.toHaveProperty("noRerank");
  });

  it("passes noRerank only when --no-rerank was explicitly selected", async () => {
    process.argv = [
      "node",
      "cli.mjs",
      "search",
      "needle",
      "--no-rerank",
      "--dashboard-url",
      "http://127.0.0.1:4410/memory",
    ];

    await import("../../src/cli.js");

    expect(runSearchMock).toHaveBeenCalledOnce();
    expect(runSearchMock.mock.calls[0]?.[1]).toMatchObject({
      noRerank: true,
    });
  });
});
