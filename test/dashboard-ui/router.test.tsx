import { describe, expect, it } from "vitest";
import { router } from "../../src/dashboard-ui/router.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("dashboard router", () => {
  it("uses the /memory production basepath", () => {
    expect(router.options.basepath).toBe("/memory");
  });

  it("sets the browser tab title to Memory Fort", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const indexHtml = readFileSync(resolve(testDir, "../../src/dashboard-ui/index.html"), "utf8");
    const parsed = new DOMParser().parseFromString(indexHtml, "text/html");

    expect(parsed.title).toContain("Memory Fort");
  });
});
