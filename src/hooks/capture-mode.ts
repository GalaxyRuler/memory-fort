import type { MemoryConfig } from "../storage/config.js";

export type CaptureMode = "full" | "summary" | "metadata" | "skip";

const VALID_MODES = new Set<string>(["full", "summary", "metadata", "skip"]);

export function readCaptureMode(
  config: MemoryConfig,
  toolName: string,
  toolInputJson?: string,
): CaptureMode {
  if (toolInputJson) {
    const patterns = config.capture?.exclude_patterns;
    if (Array.isArray(patterns)) {
      for (const pattern of patterns) {
        if (typeof pattern !== "string") continue;
        try {
          if (new RegExp(pattern).test(toolInputJson)) return "skip";
        } catch {
          // invalid regex — skip
        }
      }
    }
  }

  const tools = config.capture?.tools;
  if (tools && typeof tools === "object") {
    const mode = tools[toolName];
    if (typeof mode === "string" && VALID_MODES.has(mode)) return mode as CaptureMode;
  }

  return "full";
}
