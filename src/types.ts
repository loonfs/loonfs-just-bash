import type { LoonFSClient } from "@loonfs/sdk/server";
import type { ExecOptions as JustBashExecOptions, FileContent } from "just-bash";
import type { LoonFsBackend } from "./backend/backend.js";

export interface LoonFsActor {
  kind: "user" | "service" | "system";
  id: string;
}

export type WorkspaceAccess = "read-only" | "read-write";

export interface WorkspaceLimits {
  maxExecutionTimeMs: number;
  maxOutputBytes: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxAppendSourceBytes: number;
  maxDirectoryEntries: number;
  maxTraversalEntries: number;
  maxCommandCount: number;
  maxLoopIterations: number;
  maxMutationsPerExec: number;
  maxLoonFsRequestsPerExec: number;
}

export interface CreateWorkspaceShellOptions {
  /** A prepared backend; or pass `client` and `namespaceId` instead. */
  backend?: LoonFsBackend;
  client?: LoonFSClient;
  namespaceId?: string;
  actor: LoonFsActor;
  access?: WorkspaceAccess;
  namespaceRoot?: string;
  mountPoint?: string;
  limits?: Partial<WorkspaceLimits>;
  /** One structured record per execution; never raw content or the script. */
  onExecutionSummary?: (summary: WorkspaceExecutionSummary) => void | Promise<void>;
}

export interface WorkspaceExecOptions extends JustBashExecOptions {
  toolCallId?: string;
  message?: string;
}

export interface WorkspaceFileInput {
  path: string;
  content: FileContent;
}

export interface WorkspaceFileWriteOptions {
  message?: string;
}

export type SearchMode = "server_index" | "bounded_local" | "rejected";

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  headSeqBefore?: number;
  headSeqAfter?: number;
  requests?: number;
  mutations?: number;
  bytesRead?: number;
  bytesWritten?: number;
  searchModes?: SearchMode[];
  /** Final virtual environment, matching just-bash's exec result. */
  env?: Record<string, string>;
}

export interface WorkspaceExecutionSummary {
  namespaceId: string;
  toolCallId?: string;
  message?: string;
  exitCode: number;
  durationMs: number;
  headSeqBefore?: number;
  headSeqAfter?: number;
  requests: number;
  mutations: number;
  bytesRead: number;
  bytesWritten: number;
  searchModes: SearchMode[];
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
  /** Reads a durable file relative to, or absolutely beneath, the workspace mount. */
  readFile(path: string): Promise<string>;
  /** Writes durable files relative to, or absolutely beneath, the workspace mount. */
  writeFiles(files: WorkspaceFileInput[], options?: WorkspaceFileWriteOptions): Promise<void>;
  refresh(): Promise<void>;
  info(): Promise<WorkspaceInfo>;
  close(): Promise<void>;
}
