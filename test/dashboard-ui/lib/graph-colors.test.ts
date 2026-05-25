import { describe, expect, test } from "vitest";
import { edgeColor } from "../../../src/dashboard-ui/lib/graph-colors.js";

describe("graph colors", () => {
  test("edgeColor returns rgb strings without ignored alpha components", () => {
    expect(edgeColor({ kind: "wikilink", relationType: null })).toBe("rgb(91,139,255)");
    expect(edgeColor({ kind: "relation", relationType: "mentioned_in" })).toBe("rgb(237,237,237)");
    expect(edgeColor({ kind: "relation", relationType: null })).toBe("rgb(237,237,237)");
  });
});
