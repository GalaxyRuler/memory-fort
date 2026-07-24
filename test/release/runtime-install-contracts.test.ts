import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

type PackageManifest = {
  engines?: { node?: string };
  scripts?: Record<string, string>;
  packages?: Record<string, { engines?: { node?: string } }>;
};

type WorkflowJob = {
  strategy?: { matrix?: { node?: Array<number | string> } };
  steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
};

type Workflow = {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
};

function json(path: string): PackageManifest {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as PackageManifest;
}

function workflow(name: string): Workflow {
  return load(readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")) as Workflow;
}

function setupNodeVersions(job: WorkflowJob | undefined): unknown[] {
  return (job?.steps ?? [])
    .filter((step) => step.uses === "actions/setup-node@v4")
    .map((step) => step.with?.["node-version"]);
}

describe("Node and install contracts", () => {
  it("ships a Node 22 minimum in every npm package and lockfile root", () => {
    expect(json("package.json").engines?.node).toBe(">=22");
    expect(json("package-lock.json").packages?.[""]?.engines?.node).toBe(">=22");
    expect(json("packages/sdk/package.json").engines?.node).toBe(">=22");
    expect(json("packages/sdk/package-lock.json").packages?.[""]?.engines?.node).toBe(">=22");
  });

  it("tests on Node 22 and 24 while release packaging stays pinned to Node 24", () => {
    const quality = workflow("quality-gates.yml");
    for (const jobName of ["test", "test-server"]) {
      const job = quality.jobs?.[jobName];
      expect(job?.strategy?.matrix?.node?.map(String)).toEqual(["22", "24"]);
      expect(setupNodeVersions(job)).toEqual(["${{ matrix.node }}"]);
    }
    expect(quality.jobs?.["static-and-eval"]?.strategy?.matrix?.node).toBeUndefined();
    expect(setupNodeVersions(quality.jobs?.["static-and-eval"])).toEqual(["24"]);

    const release = workflow("release.yml");
    expect(setupNodeVersions(release.jobs?.build)).toEqual(["24"]);
    expect(setupNodeVersions(release.jobs?.publish)).toEqual(["24"]);
  });

  it("uses the supported ONNX install environment seam without npm project config", () => {
    const npmrc = join(repoRoot, ".npmrc");
    const npmrcText = existsSync(npmrc) ? readFileSync(npmrc, "utf8") : "";
    expect(npmrcText).not.toMatch(/^\s*onnxruntime-node-install\s*=/mu);

    for (const name of [
      "quality-gates.yml",
      "release.yml",
      "smoke.yml",
      "installed-native-probe.yml",
      "preflight-winarm64-vec.yml",
    ]) {
      const parsed = workflow(name);
      expect(parsed.env?.ONNXRUNTIME_NODE_INSTALL, name).toBe("skip");
    }
  });

  it("runs the bounded install smoke and rejects npm unknown-config warnings", () => {
    const packageJson = json("package.json");
    expect(packageJson.scripts?.["smoke:install-contract"]).toBe(
      "node scripts/install-contract-smoke.mjs",
    );

    const node = process.execPath;
    const output = execFileSync(node, [join(repoRoot, "scripts", "install-contract-smoke.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toContain("Install contract smoke passed");
  });

  it("documents the guarded lifecycle and evidence schemas at the public reference seams", () => {
    const adr = readFileSync(join(repoRoot, "docs", "adr", "0002-runtime-and-install-contract.md"), "utf8");
    const cli = readFileSync(join(repoRoot, "docs", "cli.md"), "utf8");
    const architecture = readFileSync(join(repoRoot, "docs", "architecture.md"), "utf8");
    const schema = readFileSync(join(repoRoot, "templates", "schema.md"), "utf8");

    expect(adr).toContain("ONNXRUNTIME_NODE_INSTALL=skip");
    expect(cli).toContain("memory backup drill <archive>");
    expect(cli).toContain("memory forget --purge-history");
    expect(architecture).toContain("live-erased/history-retained");
    expect(schema).toContain("memory-fort-live-erase");
    expect(schema).toContain("memory-fort-history-purge");
    expect(schema).toContain("memory-fort-restore-drill");
  });
});
