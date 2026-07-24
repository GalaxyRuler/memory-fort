import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Install contract failed: run this smoke through npm run smoke:install-contract");
}
const installEnv = {
  ...process.env,
  ONNXRUNTIME_NODE_INSTALL: "skip",
};

const { stdout = "", stderr = "" } = await execFileAsync(
  process.execPath,
  [npmCli, "config", "list", "--location=project"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: installEnv,
    windowsHide: true,
  },
);

const npmOutput = `${stdout}\n${stderr}`;
if (/npm warn Unknown .*config/iu.test(npmOutput)) {
  throw new Error("Install contract failed: npm reported an unknown configuration key");
}

const onnxInstallUtils = await readFile(
  join(repoRoot, "node_modules", "onnxruntime-node", "script", "install-utils.js"),
  "utf8",
);
if (!onnxInstallUtils.includes("process.env.ONNXRUNTIME_NODE_INSTALL")) {
  throw new Error("Install contract failed: pinned onnxruntime-node does not read ONNXRUNTIME_NODE_INSTALL");
}
if (!/case ['"]skip['"]:\s*return false;/u.test(onnxInstallUtils)) {
  throw new Error("Install contract failed: pinned onnxruntime-node does not implement the skip value");
}

process.stdout.write("Install contract smoke passed: npm config is known and ONNXRUNTIME_NODE_INSTALL=skip is supported.\n");
