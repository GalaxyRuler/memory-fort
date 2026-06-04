import { describe, expect, it } from "vitest";
import {
  deriveBinName,
  formatNextSteps,
} from "../../../src/cli/commands/next-steps.js";

describe("post-setup next steps", () => {
  it("prints the vault, doctor, grep, dashboard, and optional provider note", () => {
    const output = formatNextSteps({
      vault: "C:\\tmp\\.memory",
      bin: "memory",
    });

    expect(output).toContain("C:\\tmp\\.memory");
    expect(output).toContain("Verify it works:  memory doctor");
    expect(output).toContain("Search now:       memory grep \"<term>\"");
    expect(output).toContain("Browse + search:  memory dashboard");
    expect(output).toContain("Embeddings and LLMs are optional");
    expect(output).not.toContain("memory search \"<term>\"");
  });

  it("derives the command name from argv[1] with memory as the fallback", () => {
    expect(deriveBinName(["node", "C:\\Users\\me\\AppData\\Roaming\\npm\\memory.cmd"])).toBe("memory");
    expect(deriveBinName(["node", "C:\\repo\\dist\\cli.mjs"])).toBe("memory");
    expect(deriveBinName(["node", ""])).toBe("memory");
  });
});
