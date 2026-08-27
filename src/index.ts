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
