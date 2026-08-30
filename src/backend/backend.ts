import type { LoonFsActor } from "../types.js";

export type LoonFsEntryKind = "file" | "directory";

export interface LoonFsFileFacts {
  revisionNo: number;
  sizeBytes: number;
  committedAtMs: number;
}

export interface LoonFsEntry {
  path: string;
  name: string;
  kind: LoonFsEntryKind;
  inodeId: string;
  createdAtMs: number;
  file?: LoonFsFileFacts;
}

export interface LoonFsCapabilities {
  serverGrep: boolean;
  changeFeed: boolean;
  attributes: boolean;
  writeGuards: boolean;
}

export interface LoonFsNamespaceInfo {
  namespaceId: string;
  headSeq: number;
}

export interface MutationCommit {
  commitId: string;
  actor: LoonFsActor;
  message?: string;
}

export interface MutationReceipt {
  headSeq: number;
  entry?: LoonFsEntry;
}

export type WriteBehavior = "no-replace" | "replace";

export interface GrepQuery {
  /** Rust regex dialect at the server; patterns must carry literal bytes. */
  pattern: string;
  caseInsensitive: boolean;
  /** Complete absolute namespace path of a directory. */
  pathPrefix?: string;
  cursor?: string;
}

export interface GrepMatchEntry {
  path: string;
  lineNo: number;
  line: string;
  lineTruncated: boolean;
}

export interface GrepPage {
  matches: GrepMatchEntry[];
  nextCursor?: string;
  /** False when the unindexed tail was not fully scanned; results may lag. */
  tailScanned: boolean;
}

export interface ListDirectoryPage {
  entries: LoonFsEntry[];
  nextCursor?: string;
  headSeq: number;
}

export type BackendConditionCode =
  | "not_found"
  | "destination_exists"
  | "not_a_directory"
  | "is_a_directory"
  | "directory_not_empty"
  | "stale_revision"
  | "raced_binding"
  | "invalid_path"
  | "unsupported"
  | "unauthenticated"
  | "access_denied"
  | "busy"
  | "content_too_large"
  | "writer_fenced"
  | "internal";

export class LoonFsBackendError extends Error {
  readonly code: BackendConditionCode;
  readonly requestId: string | undefined;

  constructor(code: BackendConditionCode, message: string, requestId?: string) {
    super(message);
    this.name = "LoonFsBackendError";
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * The narrow port between the filesystem adapter and a LoonFS deployment.
 * Paths are namespace-absolute ("/reports/q3.md"); the adapter owns mount
 * mapping and the backend owns transports, credentials, and error taxonomy.
 */
export interface LoonFsBackend {
  getCapabilities(): Promise<LoonFsCapabilities>;
  getNamespace(): Promise<LoonFsNamespaceInfo>;
  stat(path: string): Promise<LoonFsEntry>;
  listDirectoryPage(
    path: string,
    options: { cursor?: string; limit: number },
  ): Promise<ListDirectoryPage>;
  readFile(path: string): Promise<{ bytes: Uint8Array; entry: LoonFsEntry }>;
  writeFile(
    path: string,
    bytes: Uint8Array,
    options: {
      behavior: WriteBehavior;
      expectedInodeId?: string;
      expectedRevisionNo?: number;
      commit: MutationCommit;
    },
  ): Promise<MutationReceipt>;
  createDirectory(
    path: string,
    options: { parents: boolean; commit: MutationCommit },
  ): Promise<MutationReceipt>;
  deletePath(
    path: string,
    options: { recursive: boolean; expectedInodeId?: string; commit: MutationCommit },
  ): Promise<MutationReceipt>;
  movePath(
    fromPath: string,
    toPath: string,
    options: {
      behavior: WriteBehavior;
      destinationExpectedInodeId?: string;
      destinationExpectedRevisionNo?: number;
      commit: MutationCommit;
    },
  ): Promise<MutationReceipt>;
  copyFile(
    fromPath: string,
    toPath: string,
    options: {
      behavior: WriteBehavior;
      destinationExpectedInodeId?: string;
      destinationExpectedRevisionNo?: number;
      commit: MutationCommit;
    },
  ): Promise<MutationReceipt>;
  updateAttributes?(
    path: string,
    options: {
      set: Record<string, string>;
      remove: string[];
      expectedInodeId?: string;
      commit: MutationCommit;
    },
  ): Promise<MutationReceipt>;
  grepNamespace?(query: GrepQuery): Promise<GrepPage>;
}
