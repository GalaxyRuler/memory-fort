import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../../tsdown.config.js";

describe("dashboard build robustness", () => {
  it("scopes the server clean so dist/dashboard-ui is not removed", () => {
    expect(Array.isArray(tsdownConfig)).toBe(true);
    const serverBuild = Array.isArray(tsdownConfig) ? tsdownConfig[0] : null;

    expect(serverBuild?.clean).toEqual(expect.arrayContaining([
      "dist/*.mjs",
      "dist/*.d.mts",
      "dist/*.mjs.map",
    ]));
    expect(serverBuild?.clean).not.toEqual(true);
    expect(serverBuild?.clean).not.toContain("dist/dashboard-ui");
  });

  it("makes npm run build finish by building the dashboard UI", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["build"]).toContain("npm run build:ui");
  });
});
