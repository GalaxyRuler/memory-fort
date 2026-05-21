import { describe, it, expect } from "vitest";
import { renderTemplate } from "../../src/cli/template-render.js";

describe("renderTemplate", () => {
  it("substitutes known variables", () => {
    const out = renderTemplate("Hello {{name}}, today is {{date}}.", {
      name: "Abdullah",
      date: "2026-05-21",
    });
    expect(out).toBe("Hello Abdullah, today is 2026-05-21.");
  });

  it("leaves unknown variables intact and visible to the user", () => {
    const out = renderTemplate("Hi {{unknown}}.", {});
    expect(out).toBe("Hi {{unknown}}.");
  });

  it("handles multiple occurrences of the same variable", () => {
    const out = renderTemplate("{{x}} and {{x}} again", { x: "Y" });
    expect(out).toBe("Y and Y again");
  });

  it("does not match malformed placeholders", () => {
    const out = renderTemplate("{ {x} } {{x }} {{ x}}", { x: "Y" });
    expect(out).toBe("{ {x} } {{x }} {{ x}}");
  });
});
