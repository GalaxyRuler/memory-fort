import { describe, it, expect } from "vitest";
import { getChatGptBridgePort } from "../../src/storage/config.js";

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
