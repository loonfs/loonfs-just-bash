import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_LIMITS, resolveWorkspaceLimits } from "../../src/index.js";

describe("workspace limit configuration", () => {
  it("accepts zero as an explicit deny-all budget", () => {
    expect(resolveWorkspaceLimits({ maxMutationsPerExec: 0 }).maxMutationsPerExec).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid numeric limit (%s)",
    (value) => {
      expect(() => resolveWorkspaceLimits({ maxReadBytes: value })).toThrow(
        /limits\.maxReadBytes must be a non-negative safe integer/,
      );
    },
  );

  it("does not mutate the defaults when resolving overrides", () => {
    const resolved = resolveWorkspaceLimits({ maxReadBytes: 7 });
    expect(resolved.maxReadBytes).toBe(7);
    expect(DEFAULT_WORKSPACE_LIMITS.maxReadBytes).not.toBe(7);
    expect(Object.isFrozen(DEFAULT_WORKSPACE_LIMITS)).toBe(true);
  });

  it("rejects unknown workspace limits", () => {
    expect(() => resolveWorkspaceLimits({ maxIndexedPaths: 1 } as never)).toThrow(
      /maxIndexedPaths is not a workspace limit/,
    );
  });
});
