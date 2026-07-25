import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Record<string, unknown>>;
};

function workflow(name: string): Workflow {
  return load(readFileSync(join(repoRoot, ".github", "workflows", name), "utf-8")) as Workflow;
}

describe("release workflow contracts", () => {
  it("routes CI through the reusable quality gate", () => {
    const ci = workflow("ci.yml");

    expect(Object.keys(ci.jobs ?? {})).toEqual(["quality"]);
    expect(ci.jobs?.quality?.uses).toBe("./.github/workflows/quality-gates.yml");
  });

  it("makes retrieval and dispatch evaluations blocking quality gates", () => {
    const quality = workflow("quality-gates.yml");
    const serializedJobs = JSON.stringify(quality.jobs);

    expect(quality.on).toHaveProperty("workflow_call");
    expect(serializedJobs).toContain("assert-eval-thresholds.mjs");
    expect(serializedJobs).not.toContain('"continue-on-error":true');
  });

  it("packages without publishing and publishes only after every platform succeeds", () => {
    const release = workflow("release.yml");
    const build = release.jobs?.build;
    const publish = release.jobs?.publish;
    const buildSteps = JSON.stringify(build?.steps);
    const publishSteps = JSON.stringify(publish?.steps);

    expect(release.permissions?.contents).toBe("read");
    expect(release.jobs?.quality?.uses).toBe("./.github/workflows/quality-gates.yml");
    expect(build?.needs).toBe("quality");
    expect(buildSteps).toContain("--publish never");
    expect(buildSteps).toContain("actions/upload-artifact@v4");
    expect(buildSteps).not.toContain("--publish always");
    expect(buildSteps).not.toContain("gh release upload");

    expect(publish?.needs).toEqual(["quality", "build"]);
    expect((publish?.permissions as Record<string, string>)?.contents).toBe("write");
    expect(publishSteps).toContain("actions/download-artifact@v4");
    expect(publishSteps).toContain("validate-desktop-artifacts.mjs");
    expect(publishSteps).toContain("gh release upload");
  });

  it("scans every packaged application payload before release artifacts are zipped or uploaded", () => {
    const release = workflow("release.yml");
    const steps = (release.jobs?.build?.steps ?? []) as Array<{ name?: string; run?: string; if?: string }>;
    const indexOf = (name: string) => steps.findIndex((step) => step.name === name);
    const packageIndex = indexOf("Package desktop app without publishing");
    const unpackedScanIndex = indexOf("Scan unpacked packaged app payload");
    const linuxScanIndex = indexOf("Scan extracted Linux app payload");
    const zipIndex = indexOf("Zip installers (Windows)");
    const uploadIndex = indexOf("Upload validated package inputs");

    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(unpackedScanIndex).toBeGreaterThan(packageIndex);
    expect(linuxScanIndex).toBeGreaterThan(packageIndex);
    expect(zipIndex).toBeGreaterThan(unpackedScanIndex);
    expect(zipIndex).toBeGreaterThan(linuxScanIndex);
    expect(uploadIndex).toBeGreaterThan(unpackedScanIndex);
    expect(uploadIndex).toBeGreaterThan(linuxScanIndex);
    expect(steps[unpackedScanIndex]?.run).toContain("npm run scan:leaks:package");
    expect(steps[unpackedScanIndex]?.if).toBe("runner.os != 'Linux'");
    expect(steps[linuxScanIndex]?.run).toContain("--appimage-extract");
    expect(steps[linuxScanIndex]?.run).toContain("--packaged-root");
    expect(steps[linuxScanIndex]?.if).toBe("runner.os == 'Linux'");
  });
});
