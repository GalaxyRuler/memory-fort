import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VerifyRole } from "./types.js";

export function detectRole(env: NodeJS.ProcessEnv = process.env): VerifyRole {
  const override = env["MEMORY_ROLE"]?.toLowerCase();
  if (override === "server") return "server";
  if (override === "operator") return "operator";

  const isVpsInstall = env["MEMORY_INSTALL_ROOT"] === "/root/memory-system";
  const codexConfigExists = existsSync(join(homedir(), ".codex", "config.toml"));
  const claudeSettingsExists = existsSync(join(homedir(), ".claude", "settings.json"));

  if (isVpsInstall && !codexConfigExists && !claudeSettingsExists) {
    return "server";
  }
  return "operator";
}
