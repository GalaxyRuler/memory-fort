import { describe, it, expect } from "vitest";
import { getChatGptBridgePort, validateMemoryConfig } from "../../src/storage/config.js";

describe("getChatGptBridgePort", () => {
  it("returns 3100 when chatgpt is undefined", () => {
    expect(getChatGptBridgePort({})).toBe(3100);
  });

  it("returns 3100 when bridge_port is undefined", () => {
    expect(getChatGptBridgePort({ chatgpt: {} })).toBe(3100);
  });

  it("returns configured port", () => {
    expect(getChatGptBridgePort({ chatgpt: { bridge_port: 4200 } })).toBe(4200);
  });
});

describe("chatgpt.bridge_port validation", () => {
  it("rejects port below minimum (1023)", () => {
    const warnings = validateMemoryConfig({ chatgpt: { bridge_port: 1023 } });
    expect(warnings.some((w) => w.includes("chatgpt.bridge_port"))).toBe(true);
  });

  it("rejects port above maximum (65536)", () => {
    const warnings = validateMemoryConfig({ chatgpt: { bridge_port: 65536 } });
    expect(warnings.some((w) => w.includes("chatgpt.bridge_port"))).toBe(true);
  });

  it("rejects non-integer port (3.14)", () => {
    const warnings = validateMemoryConfig({ chatgpt: { bridge_port: 3.14 } } as never);
    expect(warnings.some((w) => w.includes("chatgpt.bridge_port"))).toBe(true);
  });

  it("accepts valid port (3100)", () => {
    const warnings = validateMemoryConfig({ chatgpt: { bridge_port: 3100 } });
    expect(warnings.some((w) => w.includes("chatgpt.bridge_port"))).toBe(false);
  });
});
