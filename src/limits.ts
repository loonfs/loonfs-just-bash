import type { WorkspaceLimits } from "./types.js";

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxReadBytes: 32 * 1024 * 1024,
  maxWriteBytes: 32 * 1024 * 1024,
  maxAppendSourceBytes: 8 * 1024 * 1024,
  maxDirectoryEntries: 10_000,
  maxIndexedPaths: 50_000,
  maxMutationsPerExec: 1_000,
  maxConcurrentRequests: 16,
  maxLoonFsRequestsPerExec: 2_000,
};

export function resolveWorkspaceLimits(overrides?: Partial<WorkspaceLimits>): WorkspaceLimits {
  return { ...DEFAULT_WORKSPACE_LIMITS, ...overrides };
}
