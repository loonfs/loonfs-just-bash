import type { MutationContext } from "../fs/mutation-context.js";
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
 * The session's view of a backend: every call except capability and head
 * telemetry counts against the execution's request budget, and a fenced
 * writer latches the session read-only until refresh() clears it.
 */
export class SessionBackend implements LoonFsBackend {
  private readonly inner: LoonFsBackend;
  private readonly context: MutationContext;
  private fenced = false;

  constructor(inner: LoonFsBackend, context: MutationContext) {
    this.inner = inner;
    this.context = context;
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
    return this.observed("stat", path, () => this.inner.stat(path));
  }

  async listDirectoryPage(
    path: string,
    options: { cursor?: string; limit: number },
  ): Promise<ListDirectoryPage> {
    return this.observed("scandir", path, () => this.inner.listDirectoryPage(path, options));
  }

  async readFile(path: string): Promise<{ bytes: Uint8Array; entry: LoonFsEntry }> {
    return this.observed("read", path, () => this.inner.readFile(path));
  }

  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: { behavior: WriteBehavior; expectedRevisionNo?: number; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutating("write", path, () => this.inner.writeFile(path, bytes, options));
  }

  async createDirectory(
    path: string,
    options: { parents: boolean; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutating("mkdir", path, () => this.inner.createDirectory(path, options));
  }

  async deletePath(
    path: string,
    options: { recursive: boolean; expectedInodeId?: string; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutating("rm", path, () => this.inner.deletePath(path, options));
  }

  async movePath(
    fromPath: string,
    toPath: string,
    options: { behavior: WriteBehavior; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutating("rename", fromPath, () => this.inner.movePath(fromPath, toPath, options));
  }

  async copyFile(
    fromPath: string,
    toPath: string,
    options: { behavior: WriteBehavior; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutating("cp", fromPath, () => this.inner.copyFile(fromPath, toPath, options));
  }

  async grepNamespace(query: GrepQuery): Promise<GrepPage> {
    if (this.inner.grepNamespace === undefined) {
      throw new LoonFsBackendError("unsupported", "content search is not available");
    }
    return this.observed("grep", query.pathPrefix ?? "/", () => this.inner.grepNamespace!(query));
  }

  private async observed<T>(syscall: string, path: string, call: () => Promise<T>): Promise<T> {
    this.context.countRequest(syscall, path);
    try {
      return await call();
    } catch (error) {
      this.latchOnFence(error);
      throw error;
    }
  }

  private async mutating<T>(syscall: string, path: string, call: () => Promise<T>): Promise<T> {
    if (this.fenced) {
      throw new LoonFsBackendError(
        "writer_fenced",
        "the namespace writer was fenced earlier in this session; refresh() clears the latch after operator intervention",
      );
    }
    return this.observed(syscall, path, call);
  }

  private latchOnFence(error: unknown): void {
    if (error instanceof LoonFsBackendError && error.code === "writer_fenced") {
      this.fenced = true;
    }
  }
}
