import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMemoryConfigYaml, validateMemoryConfig } from "../../../storage/config.js";
import type { CheckDescriptor } from "./types.js";
import { fail, pass, warn } from "./types.js";

export const configValidCheck: CheckDescriptor = {
  id: "config.valid",
  label: "config.yaml parses and validates",
  roles: ["operator", "server"],
  run: async ({ vaultRoot }) => {
    const path = join(vaultRoot, "config.yaml");
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (error) {
      if (isMissingFile(error)) return pass("config.valid", "config.yaml parses and validates", "config.yaml missing; defaults active");
      return fail("config.valid", "config.yaml parses and validates", "check config.yaml permissions", String(error));
    }

    try {
      const config = parseMemoryConfigYaml(raw, path);
      const warnings = validateMemoryConfig(config);
      if (warnings.length > 0) {
        return warn(
          "config.valid",
          "config.yaml parses and validates",
          warnings.join("; "),
          "fix invalid config values",
        );
      }
      return pass("config.valid", "config.yaml parses and validates", "config.yaml ok");
    } catch (error) {
      return fail(
        "config.valid",
        "config.yaml parses and validates",
        "fix config.yaml syntax",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
