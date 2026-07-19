import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  isStrictChild,
  parseSafeRelativeSegments,
  resolveStrictChild,
} from "../../src/storage/path-safety.js";

describe("path-safety", () => {
  // resolve() so the fixture is drive-qualified on Windows (a bare /tmp parent
  // resolves with the cwd drive and join() would not match).
  const parent = resolve("/tmp", "vault", "wiki");

  it("accepts simple relative wiki paths", () => {
    expect(parseSafeRelativeSegments("projects/foo.md")).toEqual(["projects", "foo.md"]);
    const resolved = resolveStrictChild(parent, "projects/foo.md");
    expect(resolved).toBe(join(parent, "projects", "foo.md"));
    expect(isStrictChild(parent, resolved!)).toBe(true);
  });

  it("accepts Obsidian-style filenames with spaces", () => {
    expect(parseSafeRelativeSegments("projects/My Project.md")).toEqual([
      "projects",
      "My Project.md",
    ]);
    const resolved = resolveStrictChild(parent, "projects/My Project.md");
    expect(resolved).toBe(join(parent, "projects", "My Project.md"));
  });

  it("rejects .. traversal", () => {
    expect(parseSafeRelativeSegments("../secrets.md")).toBeNull();
    expect(parseSafeRelativeSegments("projects/../../etc/passwd")).toBeNull();
    expect(resolveStrictChild(parent, "../secrets.md")).toBeNull();
  });

  it("rejects Windows-normalized spaced/trailing-dot traversal segments", () => {
    // On Windows, trailing spaces/dots are stripped so ".. " → ".."
    expect(parseSafeRelativeSegments("projects/.. /secrets.md")).toBeNull();
    expect(parseSafeRelativeSegments("projects/.. /.. /secrets.md")).toBeNull();
    expect(parseSafeRelativeSegments("projects/. /foo.md")).toBeNull();
    expect(resolveStrictChild(parent, "projects/.. /.. /secrets.md")).toBeNull();
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

  it("rejects drive-relative prefixes without a slash (C:foo)", () => {
    expect(parseSafeRelativeSegments("C:tools/git.md")).toBeNull();
    expect(parseSafeRelativeSegments("c:foo.md")).toBeNull();
    expect(resolveStrictChild(parent, "C:tools/git.md")).toBeNull();
  });

  it("rejects root-relative backslash paths", () => {
    expect(parseSafeRelativeSegments("\\Windows\\system32\\x.md")).toBeNull();
  });

  it("rejects control characters in segments", () => {
    expect(parseSafeRelativeSegments("projects/foo\nbar.md")).toBeNull();
  });

  it("rejects empty and null-byte paths", () => {
    expect(parseSafeRelativeSegments("")).toBeNull();
    expect(parseSafeRelativeSegments("a\0b.md")).toBeNull();
  });
});
