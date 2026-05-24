import { describe, expect, it } from "vitest";
import { router } from "../../src/dashboard-ui/router.js";

describe("dashboard router", () => {
  it("uses the /memory production basepath", () => {
    expect(router.options.basepath).toBe("/memory");
  });
});
