import type { LoonFSClient, LoonFS } from "@loonfs/sdk/server";
import { LoonFSError } from "@loonfs/sdk/server";
import type {
  GrepPage,
  GrepQuery,
  ListDirectoryPage,
  LoonFsBackend,
  LoonFsCapabilities,
  LoonFsEntry,
  LoonFsNamespaceInfo,
  MutationCommit,
  MutationReceipt,
  WriteBehavior,
} from "./backend.js";
import { LoonFsBackendError } from "./backend.js";

export interface HttpBackendOptions {
  client: LoonFSClient;
  namespaceId: string;
}

/**
 * The port over a hosted LoonFS deployment through the generated client.
 * Transfers pick their mechanism from advertised capabilities inside the
 * SDK helpers; errors are folded to port conditions with the request id
 * kept and nothing provider-internal exposed.
 */
export class HttpLoonFsBackend implements LoonFsBackend {
  private readonly client: LoonFSClient;
  private readonly namespaceId: string;

  constructor(options: HttpBackendOptions) {
    this.client = options.client;
    this.namespaceId = options.namespaceId;
  }

  async getCapabilities(): Promise<LoonFsCapabilities> {
    const document = await this.mapped(() => this.client.capabilities.retrieve());
    const features = document.features ?? {};
    return {
      serverGrep: features["query.grep"] === true,
      changeFeed: features["core.changes"] === true,
      attributes: features["core.attributes"] === true,
    };
  }

  async getNamespace(): Promise<LoonFsNamespaceInfo> {
    const namespace = await this.mapped(() =>
      this.client.namespaces.retrieve({ namespace_id: this.namespaceId }),
    );
    return { namespaceId: this.namespaceId, headSeq: Number(namespace.head_seq) };
  }

  async stat(path: string): Promise<LoonFsEntry> {
    const entry = await this.mapped(() =>
      this.client.files.retrieve({ namespace_id: this.namespaceId, path }),
    );
    return mapEntry(entry, path);
  }

  async listDirectoryPage(
    path: string,
    options: { cursor?: string; limit: number },
  ): Promise<ListDirectoryPage> {
    const page = await this.mapped(async () =>
      (
        await this.client.files.list({
        namespace_id: this.namespaceId,
        path,
        limit: options.limit,
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        })
      ).response,
    );
    const result: ListDirectoryPage = {
      entries: page.entries.map((entry) => mapEntry(entry, entry.path)),
      headSeq: Number(page.head_seq),
    };
    if (page.next_cursor != null) {
      result.nextCursor = page.next_cursor;
    }
    return result;
  }

  async readFile(path: string): Promise<{ bytes: Uint8Array; entry: LoonFsEntry }> {
    const entry = await this.stat(path);
    const downloaded = await this.mapped(() =>
      this.client.files.download({ namespace_id: this.namespaceId, path }),
    );
    return { bytes: downloaded.content, entry };
  }

  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: {
      behavior: WriteBehavior;
      expectedInodeId?: string;
      expectedRevisionNo?: number;
      commit: MutationCommit;
    },
  ): Promise<MutationReceipt> {
    try {
      const response = await withIdentityGuard(options.expectedInodeId, () =>
        this.retried(() =>
          this.client.files.upload({
            namespace_id: this.namespaceId,
            path,
            content: bytes,
            actor: options.commit.actor,
            commit_id: options.commit.commitId,
            message: options.commit.message ?? null,
            behavior: options.behavior === "replace" ? "replace" : "no_replace",
            ...(options.expectedInodeId !== undefined
              ? { expected_inode_id: options.expectedInodeId }
              : {}),
            ...(options.expectedRevisionNo !== undefined
              ? { expected_revision_no: options.expectedRevisionNo }
              : {}),
          }),
        ),
      );
      return { headSeq: Number(response.committed_seq) };
    } catch (error) {
      // A retried put re-stages content under a fresh content id, so a
      // commit-id reuse conflict means the first attempt's commit landed.
      if (error instanceof LoonFsBackendError && error.code === "internal" && isReuseConflict(error)) {
        return { headSeq: (await this.getNamespace()).headSeq };
      }
      throw error;
    }
  }

  async createDirectory(
    path: string,
    options: { parents: boolean; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.commitOne(options.commit, {
      kind: "create_directory",
      path,
      parents: options.parents,
    });
  }

  async deletePath(
    path: string,
    options: { recursive: boolean; expectedInodeId?: string; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.commitOne(options.commit, {
      kind: "delete_path",
      path,
      behavior: options.recursive ? "recursive" : "non_recursive",
      ...(options.expectedInodeId !== undefined
        ? { expected_inode_id: options.expectedInodeId }
        : {}),
    });
  }

  async movePath(
    fromPath: string,
    toPath: string,
    options: {
      behavior: WriteBehavior;
      expectedDestinationInodeId?: string;
      expectedDestinationRevisionNo?: number;
      commit: MutationCommit;
    },
  ): Promise<MutationReceipt> {
    return withIdentityGuard(options.expectedDestinationInodeId, () =>
      this.commitOne(options.commit, {
        kind: "move_path",
        from_path: fromPath,
        to_path: toPath,
        behavior: options.behavior === "replace" ? "replace" : "no_replace",
        ...(options.expectedDestinationInodeId !== undefined
          ? { expected_destination_inode_id: options.expectedDestinationInodeId }
          : {}),
        ...(options.expectedDestinationRevisionNo !== undefined
          ? { expected_destination_revision_no: options.expectedDestinationRevisionNo }
          : {}),
      }),
    );
  }

  async copyFile(
    fromPath: string,
    toPath: string,
    options: {
      behavior: WriteBehavior;
      expectedDestinationInodeId?: string;
      expectedDestinationRevisionNo?: number;
      commit: MutationCommit;
    },
  ): Promise<MutationReceipt> {
    return withIdentityGuard(options.expectedDestinationInodeId, () =>
      this.commitOne(options.commit, {
        kind: "copy_path",
        from_path: fromPath,
        to_path: toPath,
        behavior: options.behavior === "replace" ? "replace" : "no_replace",
        ...(options.expectedDestinationInodeId !== undefined
          ? { expected_destination_inode_id: options.expectedDestinationInodeId }
          : {}),
        ...(options.expectedDestinationRevisionNo !== undefined
          ? { expected_destination_revision_no: options.expectedDestinationRevisionNo }
          : {}),
      }),
    );
  }

  async grepNamespace(query: GrepQuery): Promise<GrepPage> {
    const response = await this.mapped(async () =>
      (
        await this.client.files.grep({
        namespace_id: this.namespaceId,
        pattern: query.pattern,
        case_insensitive: query.caseInsensitive,
        allow_stale: false,
          ...(query.pathPrefix !== undefined ? { path_prefix: query.pathPrefix } : {}),
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        })
      ).response,
    );
    const page: GrepPage = {
      matches: response.matches.map((match) => ({
        path: match.path,
        lineNo: Number(match.line_number),
        line: match.line,
        lineTruncated: match.line_truncated ?? false,
      })),
      tailScanned: response.tail_scanned,
    };
    if (response.next_cursor != null) {
      page.nextCursor = response.next_cursor;
    }
    return page;
  }

  private async commitOne(
    commit: MutationCommit,
    operation: LoonFS.FilesystemOperation,
  ): Promise<MutationReceipt> {
    const response = await this.retried(() =>
      this.client.commits.create({
        namespace_id: this.namespaceId,
        actor: commit.actor,
        commit_id: commit.commitId,
        ...(commit.message !== undefined ? { message: commit.message } : {}),
        operations: [operation],
      }),
    );
    return { headSeq: Number(response.committed_seq) };
  }

  /** One retry, same commit identity, for outcomes the transport lost. */
  private async retried<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await this.mapped(call);
    } catch (error) {
      if (error instanceof LoonFsBackendError && error.code === "busy" && isAmbiguousOutcome(error)) {
        return this.mapped(call);
      }
      throw error;
    }
  }

  private async mapped<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw mapClientError(error);
    }
  }
}

function mapEntry(entry: LoonFS.PathEntry, path: string): LoonFsEntry {
  const base = {
    path,
    name: entry.display_name ?? "",
    inodeId: entry.inode_id,
    createdAtMs: Number(entry.created_at_ms),
  };
  if (entry.inode_kind === "file") {
    return {
      ...base,
      kind: "file",
      file: {
        revisionNo: Number(entry.revision_no),
        sizeBytes: Number(entry.size_bytes),
        committedAtMs: Number(entry.revision_committed_at_ms),
      },
    };
  }
  return { ...base, kind: "directory" };
}

async function withIdentityGuard<T>(
  expectedInodeId: string | undefined,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // The wire reports an inode-guard mismatch as path_conflict.
    if (
      expectedInodeId !== undefined &&
      error instanceof LoonFsBackendError &&
      error.code === "destination_exists"
    ) {
      throw new LoonFsBackendError("raced_binding", error.message, error.requestId);
    }
    throw error;
  }
}

const CODE_CONDITIONS: Record<string, LoonFsBackendError["code"]> = {
  path_not_found: "not_found",
  inode_not_found: "not_found",
  revision_not_found: "not_found",
  namespace_not_found: "not_found",
  namespace_deleted: "not_found",
  path_conflict: "destination_exists",
  namespace_exists: "destination_exists",
  directory_not_empty: "directory_not_empty",
  stale_revision: "stale_revision",
  binding_generation_mismatch: "raced_binding",
  would_cycle: "invalid_path",
  invalid_request: "invalid_path",
  wire_string: "invalid_path",
  not_supported: "unsupported",
  query_unindexable: "unsupported",
  unauthorized: "unauthenticated",
  content_too_large: "content_too_large",
  writer_fenced: "writer_fenced",
  commit_id_reuse_conflict: "internal",
  server_busy: "busy",
  shutting_down: "busy",
  commit_queue_full: "busy",
  commit_outcome_unknown: "busy",
  index_lagging: "busy",
  deadline_exceeded: "busy",
};

function mapClientError(error: unknown): LoonFsBackendError {
  if (error instanceof LoonFsBackendError) {
    return error;
  }
  if (error instanceof LoonFSError) {
    const body = (error.body ?? {}) as { code?: string; message?: string; request_id?: string };
    const transportFailure = error.statusCode === undefined && body.code === undefined;
    const condition =
      (body.code !== undefined ? CODE_CONDITIONS[body.code] : undefined) ??
      (transportFailure ? "busy" : conditionForStatus(error.statusCode));
    const mapped = new LoonFsBackendError(
      condition,
      body.message ??
        (transportFailure
          ? "the server could not be reached; the outcome of the request is unknown"
          : error.statusCode === 404
            ? "the server did not recognize this request; it may be older than this SDK"
            : `the server answered ${error.statusCode ?? "without a status"}`),
      body.request_id ?? error.requestId,
    );
    mapped.cause = body.code;
    return mapped;
  }
  if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
    return new LoonFsBackendError(
      "busy",
      "the server could not be reached; the outcome of the request is unknown",
    );
  }
  return new LoonFsBackendError(
    "internal",
    `the SDK could not complete the LoonFS request (${error instanceof Error ? error.name : typeof error})`,
  );
}

function conditionForStatus(status: number | undefined): LoonFsBackendError["code"] {
  switch (status) {
    case 404:
      return "unsupported";
    case 401:
      return "unauthenticated";
    case 403:
      return "access_denied";
    case 409:
      return "raced_binding";
    case 413:
      return "content_too_large";
    case 429:
    case 502:
    case 503:
    case 504:
      return "busy";
    case 501:
      return "unsupported";
    default:
      return "internal";
  }
}

function isAmbiguousOutcome(error: LoonFsBackendError): boolean {
  return (
    error.cause === "commit_outcome_unknown" ||
    error.message.includes("could not be reached")
  );
}

function isReuseConflict(error: LoonFsBackendError): boolean {
  return error.cause === "commit_id_reuse_conflict";
}
