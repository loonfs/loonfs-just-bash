export type {
  CreateWorkspaceShellOptions,
  LoonFsActor,
  LoonFsWorkspaceShell,
  WorkspaceAccess,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceInfo,
  WorkspaceLimits,
} from "./types.js";
export { DEFAULT_WORKSPACE_LIMITS, resolveWorkspaceLimits } from "./limits.js";
export type {
  BackendConditionCode,
  ListDirectoryPage,
  LoonFsBackend,
  LoonFsCapabilities,
  LoonFsEntry,
  LoonFsEntryKind,
  LoonFsFileFacts,
  LoonFsNamespaceInfo,
  MutationCommit,
  MutationReceipt,
  WriteBehavior,
} from "./backend/backend.js";
export { LoonFsBackendError } from "./backend/backend.js";
export { FakeLoonFsBackend } from "./backend/fake-backend.js";
export { LoonFsFileSystem } from "./fs/loonfs-filesystem.js";
export type { LoonFsFileSystemOptions } from "./fs/loonfs-filesystem.js";
export type { WorkspaceFsError } from "./fs/errors.js";
export { MutationContext } from "./fs/mutation-context.js";
export type { MutationContextOptions, WorkspaceCounters } from "./fs/mutation-context.js";
export { createLoonFsWorkspaceShell } from "./shell/workspace-shell.js";
export { WORKSPACE_COMMAND_ALLOWLIST } from "./shell/command-policy.js";
export type { GrepMatchEntry, GrepPage, GrepQuery } from "./backend/backend.js";
export type { SearchMode } from "./types.js";
export { HttpLoonFsBackend } from "./backend/http-backend.js";
export type { HttpBackendOptions } from "./backend/http-backend.js";
