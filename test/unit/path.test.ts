import { describe, expect, it } from "vitest";
import { joinVirtualPaths, normalizeVirtualPath, toNamespacePath } from "../../src/fs/path.js";

describe("virtual paths", () => {
  it("normalizes lexically and clamps at the root", () => {
    expect(normalizeVirtualPath("/a/./b//c/", "stat")).toBe("/a/b/c");
    expect(normalizeVirtualPath("/a/b/../c", "stat")).toBe("/a/c");
    expect(normalizeVirtualPath("/../../etc/passwd", "stat")).toBe("/etc/passwd");
    expect(normalizeVirtualPath("/", "stat")).toBe("/");
    expect(() => normalizeVirtualPath("/a\0b", "stat")).toThrow(/EINVAL/);
  });

  it("joins relative paths against a base", () => {
    expect(joinVirtualPaths("/a/b", "c.txt")).toBe("/a/b/c.txt");
    expect(joinVirtualPaths("/a/b", "../c.txt")).toBe("/a/c.txt");
    expect(joinVirtualPaths("/a/b", "/absolute.txt")).toBe("/absolute.txt");
  });

  it("maps virtual paths beneath the namespace root", () => {
    expect(toNamespacePath("/x/y", "/")).toBe("/x/y");
    expect(toNamespacePath("/x/y", "/teams/a")).toBe("/teams/a/x/y");
    expect(toNamespacePath("/", "/teams/a")).toBe("/teams/a");
  });
});
