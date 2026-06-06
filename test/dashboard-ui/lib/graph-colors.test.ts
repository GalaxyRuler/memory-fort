import { describe, expect, test } from "vitest";
import { edgeColor } from "../../../src/dashboard-ui/lib/graph-colors.js";

describe("graph colors", () => {
  test("edgeColor returns rgb strings without ignored alpha components", () => {
    expect(edgeColor({ kind: "wikilink", relationType: null })).toBe("rgb(34, 211, 238)");
    expect(edgeColor({ kind: "relation", relationType: "mentioned_in" })).toBe("rgb(155, 164, 184)");
    expect(edgeColor({ kind: "relation", relationType: null })).toBe("rgb(155, 164, 184)");
  });
});
