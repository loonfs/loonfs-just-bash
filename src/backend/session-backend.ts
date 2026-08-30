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

/**
 * The session's view of a backend: a fenced writer latches the session
 * read-only until refresh() clears it. Request accounting stays at the
 * filesystem and command boundaries so the exported filesystem adapter
 * enforces the same budgets when it is used without a workspace shell.
 */
export class SessionBackend implements LoonFsBackend {
  private readonly inner: LoonFsBackend;
  private fenced = false;

  constructor(inner: LoonFsBackend) {
    this.inner = inner;
  }

  clearFence(): void {
    this.fenced = false;
  }

  async getCapabilities(): Promise<LoonFsCapabilities> {
    return this.inner.getCapabilities();
  }

  async getNamespace(): Promise<LoonFsNamespaceInfo> {
    return this.inner.getNamespace();
  }

  async stat(path: string): Promise<LoonFsEntry> {
    return this.observed(() => this.inner.stat(path));
  }

  async listDirectoryPage(
    path: string,
    options: { cursor?: string; limit: number },
  ): Promise<ListDirectoryPage> {
    return this.observed(() => this.inner.listDirectoryPage(path, options));
  }

  async readFile(path: string): Promise<{ bytes: Uint8Array; entry: LoonFsEntry }> {
    return this.observed(() => this.inner.readFile(path));
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
    return this.mutating(() => this.inner.writeFile(path, bytes, options));
  }

  async createDirectory(
    path: string,
    options: { parents: boolean; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutating(() => this.inner.createDirectory(path, options));
  }

  async deletePath(
    path: string,
    options: { recursive: boolean; expectedInodeId?: string; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutating(() => this.inner.deletePath(path, options));
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
    return this.mutating(() => this.inner.movePath(fromPath, toPath, options));
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
    return this.mutating(() => this.inner.copyFile(fromPath, toPath, options));
  }

  async grepNamespace(query: GrepQuery): Promise<GrepPage> {
    if (this.inner.grepNamespace === undefined) {
      throw new LoonFsBackendError("unsupported", "content search is not available");
    }
    return this.observed(() => this.inner.grepNamespace!(query));
  }

  private async observed<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.latchOnFence(error);
      throw error;
    }
  }

  private async mutating<T>(call: () => Promise<T>): Promise<T> {
    if (this.fenced) {
      throw new LoonFsBackendError(
        "writer_fenced",
        "the namespace writer was fenced earlier in this session; refresh() clears the latch after operator intervention",
      );
    }
    return this.observed(call);
  }

  private latchOnFence(error: unknown): void {
    if (error instanceof LoonFsBackendError && error.code === "writer_fenced") {
      this.fenced = true;
    }
  }
}
