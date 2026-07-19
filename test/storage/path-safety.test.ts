import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  isStrictChild,
  parseSafeRelativeSegments,
  resolveStrictChild,
} from "../../src/storage/path-safety.js";

describe("path-safety", () => {
  const parent = join("/tmp", "vault", "wiki");

  it("accepts simple relative wiki paths", () => {
    expect(parseSafeRelativeSegments("projects/foo.md")).toEqual(["projects", "foo.md"]);
    const resolved = resolveStrictChild(parent, "projects/foo.md");
    expect(resolved).toBe(join(parent, "projects", "foo.md"));
    expect(isStrictChild(parent, resolved!)).toBe(true);
  });

  it("rejects .. traversal", () => {
    expect(parseSafeRelativeSegments("../secrets.md")).toBeNull();
    expect(resolveStrictChild(parent, "../secrets.md")).toBeNull();
  });

  it("rejects absolute POSIX paths", () => {
    expect(parseSafeRelativeSegments("/etc/passwd")).toBeNull();
    expect(resolveStrictChild(parent, "/etc/passwd")).toBeNull();
  });

  it("rejects uppercase and lowercase Windows drive paths", () => {
    expect(parseSafeRelativeSegments("C:/Windows/system32/secret.md")).toBeNull();
    expect(parseSafeRelativeSegments("c:/Users/x/.ssh/id_rsa")).toBeNull();
    expect(resolveStrictChild(parent, "c:\\Users\\x\\file.md")).toBeNull();
  });

  it("rejects root-relative backslash paths", () => {
    expect(parseSafeRelativeSegments("\\Windows\\system32\\x.md")).toBeNull();
  });

  it("rejects unsafe segment characters", () => {
    expect(parseSafeRelativeSegments("projects/foo bar.md")).toBeNull();
    expect(parseSafeRelativeSegments("projects/foo;rm.md")).toBeNull();
  });

  it("rejects empty and null-byte paths", () => {
    expect(parseSafeRelativeSegments("")).toBeNull();
    expect(parseSafeRelativeSegments("a\0b.md")).toBeNull();
  });
});
