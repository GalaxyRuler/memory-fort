import type { VerifyRole } from "./types.js";

export function detectRole(env: NodeJS.ProcessEnv = process.env): VerifyRole {
  const override = env["MEMORY_ROLE"]?.toLowerCase();
  if (override === "server") return "server";
  if (override === "operator") return "operator";
  return "operator";
}
