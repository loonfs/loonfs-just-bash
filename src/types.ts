import type { LoonFsBackend } from "./backend/backend.js";

export interface LoonFsActor {
  kind: "user" | "service" | "system";
  id: string;
}

export type WorkspaceAccess = "read-only" | "read-write";

export interface WorkspaceLimits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxAppendSourceBytes: number;
  maxDirectoryEntries: number;
  maxIndexedPaths: number;
  maxMutationsPerExec: number;
  maxConcurrentRequests: number;
  maxLoonFsRequestsPerExec: number;
}

export interface CreateWorkspaceShellOptions {
  backend: LoonFsBackend;
  actor: LoonFsActor;
  access?: WorkspaceAccess;
  namespaceRoot?: string;
  mountPoint?: string;
  limits?: Partial<WorkspaceLimits>;
}

export interface WorkspaceExecOptions {
  toolCallId?: string;
  message?: string;
}

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  headSeqBefore?: number;
  headSeqAfter?: number;
  mutations?: number;
  bytesRead?: number;
  bytesWritten?: number;
}

export interface WorkspaceInfo {
  namespaceId: string;
  mountPoint: string;
  access: WorkspaceAccess;
  headSeq: number;
  limits: WorkspaceLimits;
}

export interface LoonFsWorkspaceShell {
  exec(script: string, options?: WorkspaceExecOptions): Promise<WorkspaceExecResult>;
  refresh(): Promise<void>;
  info(): Promise<WorkspaceInfo>;
  close(): Promise<void>;
}
