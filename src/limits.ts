import type { WorkspaceLimits } from "./types.js";

export const DEFAULT_WORKSPACE_LIMITS: Readonly<WorkspaceLimits> = Object.freeze({
  maxExecutionTimeMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxReadBytes: 32 * 1024 * 1024,
  maxWriteBytes: 32 * 1024 * 1024,
  maxAppendSourceBytes: 8 * 1024 * 1024,
  maxDirectoryEntries: 10_000,
  maxTraversalEntries: 50_000,
  maxCommandCount: 1_000,
  maxLoopIterations: 10_000,
  maxMutationsPerExec: 1_000,
  maxLoonFsRequestsPerExec: 2_000,
});

export function resolveWorkspaceLimits(overrides?: Partial<WorkspaceLimits>): WorkspaceLimits {
  const resolved = { ...DEFAULT_WORKSPACE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`limits.${name} must be a non-negative safe integer`);
    }
  }
  return resolved;
}
