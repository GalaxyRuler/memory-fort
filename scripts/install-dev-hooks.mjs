#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hooksDir = join(process.cwd(), ".git", "hooks");
const hookPath = join(hooksDir, "pre-push");
const hook = [
  "#!/bin/sh",
  'remote="$1"',
  'if [ "$remote" = "origin" ]; then',
  "  node scripts/scan-leaks.mjs || exit 1",
  "fi",
  "",
].join("\n");

mkdirSync(hooksDir, { recursive: true });
writeFileSync(hookPath, hook, "utf8");
if (process.platform !== "win32") {
  chmodSync(hookPath, 0o755);
}

console.log("Memory Fort: scan-leaks pre-push hook installed.");
