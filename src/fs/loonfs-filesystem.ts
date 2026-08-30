import type {
  BufferEncoding as TextEncodingName,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import { unsafeBytesFromLatin1, type ByteString } from "just-bash";
import { Buffer } from "node:buffer";
import type { LoonFsBackend, LoonFsEntry, WriteBehavior } from "../backend/backend.js";
import { DEFAULT_WORKSPACE_LIMITS } from "../limits.js";
import type { WorkspaceAccess } from "../types.js";
import { fsError, isBackendCondition, mapBackendError } from "./errors.js";
import type { WorkspaceFsError } from "./errors.js";
import type { MutationContext } from "./mutation-context.js";
import { joinVirtualPaths, normalizeVirtualPath, toNamespacePath } from "./path.js";
import { statFromEntry } from "./stat-mapping.js";

// Not re-exported from the just-bash package root; declared structurally.
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
interface ReadFileOptions {
  encoding?: TextEncodingName | null;
}
interface WriteFileOptions {
  encoding?: TextEncodingName;
}

export interface LoonFsFileSystemOptions {
  backend: LoonFsBackend;
  namespaceRoot?: string;
  access?: WorkspaceAccess;
  context?: MutationContext;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxAppendSourceBytes?: number;
  maxDirectoryEntries?: number;
  directoryPageSize?: number;
}

/**
 * just-bash's filesystem contract over one LoonFS namespace. Reads serve the
 * durable state; mutations carry actor attribution and revision or inode
 * guards, and a lost guard surfaces as a conflict rather than degrading to
 * an unguarded write.
 */
export class LoonFsFileSystem implements IFileSystem {
  private readonly backend: LoonFsBackend;
  private readonly namespaceRoot: string;
  private readonly access: WorkspaceAccess;
  private readonly context: MutationContext | undefined;
  private readonly maxReadBytes: number;
  private readonly maxWriteBytes: number;
  private readonly maxAppendSourceBytes: number;
  private readonly maxDirectoryEntries: number;
  private readonly directoryPageSize: number;
  private namespaceId: Promise<string> | undefined;

  constructor(options: LoonFsFileSystemOptions) {
    this.backend = options.backend;
    this.namespaceRoot = normalizeVirtualPath(options.namespaceRoot ?? "/", "mount");
    this.access = options.access ?? "read-only";
    this.context = options.context;
    if (this.access === "read-write" && this.context === undefined) {
      throw new Error("a read-write workspace filesystem needs a MutationContext");
    }
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_WORKSPACE_LIMITS.maxReadBytes;
    this.maxWriteBytes = options.maxWriteBytes ?? DEFAULT_WORKSPACE_LIMITS.maxWriteBytes;
    this.maxAppendSourceBytes =
      options.maxAppendSourceBytes ?? DEFAULT_WORKSPACE_LIMITS.maxAppendSourceBytes;
    this.maxDirectoryEntries =
      options.maxDirectoryEntries ?? DEFAULT_WORKSPACE_LIMITS.maxDirectoryEntries;
    this.directoryPageSize = Math.max(1, options.directoryPageSize ?? 1000);
  }

  async readFile(path: string, options?: ReadFileOptions | TextEncodingName): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
    return Buffer.from(bytes).toString(normalizeEncoding(encoding));
  }

  async readFileBytes(path: string): Promise<ByteString> {
    const bytes = await this.readFileBuffer(path);
    return unsafeBytesFromLatin1(Buffer.from(bytes).toString("latin1"));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const namespacePath = this.namespacePath(path, "open");
    if (this.context?.heldWrite(namespacePath)) {
      return new Uint8Array(0);
    }
    const entry = await this.statEntry(namespacePath, "open", path);
    if (entry.kind === "directory") {
      throw fsError("EISDIR", "illegal operation on a directory", "read", path);
    }
    const sizeBytes = entry.file?.sizeBytes ?? 0;
    if (sizeBytes > this.maxReadBytes) {
      throw this.limitError(
        "EFBIG",
        `file is ${sizeBytes} bytes and the configured read limit is ${this.maxReadBytes}`,
        "read",
        path,
      );
    }
    const read = await this.request(() => this.backend.readFile(namespacePath), "read", path);
    this.context?.countRead(read.bytes.byteLength);
    if (read.bytes.byteLength > this.maxReadBytes) {
      throw this.limitError(
        "EFBIG",
        `the read returned ${read.bytes.byteLength} bytes and the configured read limit is ${this.maxReadBytes}`,
        "read",
        path,
      );
    }
    return read.bytes;
  }

  async exists(path: string): Promise<boolean> {
    const namespacePath = this.namespacePath(path, "stat");
    if (this.context?.heldWrite(namespacePath)) {
      return true;
    }
    return (await this.optionalEntry(namespacePath, "stat", path)) !== undefined;
  }

  async stat(path: string): Promise<FsStat> {
    const namespacePath = this.namespacePath(path, "stat");
    if (this.context?.heldWrite(namespacePath)) {
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: 0,
        mtime: new Date(),
      };
    }
    const entry = await this.statEntry(namespacePath, "stat", path);
    return statFromEntry(entry, await this.namespaceIdOnce());
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.listAll(path);
    return [
      ...entries.map((entry) => entry.name),
      ...this.heldDirectoryNames(
        this.namespacePath(path, "scandir"),
        entries.map((entry) => entry.name),
      ),
    ];
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const entries = await this.listAll(path);
    const listed = entries.map((entry) => ({
      name: entry.name,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "directory",
      isSymbolicLink: false,
    }));
    return [
      ...listed,
      ...this.heldDirectoryNames(
        this.namespacePath(path, "scandir"),
        entries.map((entry) => entry.name),
      ).map((name) => ({
        name,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      })),
    ];
  }

  resolvePath(base: string, path: string): string {
    return joinVirtualPaths(base, path);
  }

  async realpath(path: string): Promise<string> {
    const virtual = normalizeVirtualPath(path, "realpath");
    const namespacePath = toNamespacePath(virtual, this.namespaceRoot);
    if (this.context?.heldWrite(namespacePath) !== undefined) {
      return virtual;
    }
    await this.statEntry(namespacePath, "realpath", path);
    return virtual;
  }

  /**
   * The pinned interpreter expands globs through live directory listings and
   * never calls this; if a future version does, refusing beats answering
   * with a silently incomplete snapshot.
   */
  getAllPaths(): string[] {
    throw fsError(
      "ENOTSUP",
      "this adapter serves glob expansion through live directory listings, not a path snapshot",
      "glob",
      this.namespaceRoot,
    );
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | TextEncodingName,
  ): Promise<void> {
    const context = this.writable("write", path);
    const bytes = encodeContent(content, options);
    const normalizedVirtualPath = normalizeVirtualPath(path, "write");
    const namespacePath = toNamespacePath(normalizedVirtualPath, this.namespaceRoot);
    const held = context.heldWrite(namespacePath);
    if (held !== undefined) {
      if (bytes.byteLength === 0) {
        return;
      }
      context.clearHeldWrite(namespacePath);
      await this.publish(context, namespacePath, bytes, held.existing, "write", path);
      return;
    }
    const existing = await this.optionalEntry(namespacePath, "write", path);
    if (bytes.byteLength === 0 && context.hasActiveExecution()) {
      if (existing?.kind === "directory") {
        throw fsError("EISDIR", "illegal operation on a directory", "write", path);
      }
      if (existing === undefined) {
        await this.assertParentDirectory(namespacePath, "write", path);
      }
      context.holdEmptyWrite(namespacePath, { virtualPath: normalizedVirtualPath, existing });
      return;
    }
    await this.publish(context, namespacePath, bytes, existing, "write", path);
  }

  /**
   * LoonFS stores immutable whole-file revisions, so append is a bounded
   * read-modify-write guarded by the revision whose bytes were read.
   */
  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | TextEncodingName,
  ): Promise<void> {
    const context = this.writable("append", path);
    const suffix = encodeContent(content, options);
    const normalizedVirtualPath = normalizeVirtualPath(path, "append");
    const namespacePath = toNamespacePath(normalizedVirtualPath, this.namespaceRoot);
    const held = context.heldWrite(namespacePath);
    if (held !== undefined) {
      if (suffix.byteLength === 0) {
        return;
      }
      context.clearHeldWrite(namespacePath);
      if (held.existing?.kind === "directory") {
        throw fsError("EISDIR", "illegal operation on a directory", "append", path);
      }
      await this.publish(context, namespacePath, suffix, held.existing, "append", path);
      return;
    }
    const existing = await this.optionalEntry(namespacePath, "append", path);
    if (suffix.byteLength === 0) {
      if (existing?.kind === "directory") {
        throw fsError("EISDIR", "illegal operation on a directory", "append", path);
      }
      if (existing !== undefined) {
        return;
      }
      await this.assertParentDirectory(namespacePath, "append", path);
      if (
        context.hasActiveExecution() &&
        context.holdEmptyWrite(namespacePath, {
          virtualPath: normalizedVirtualPath,
          existing: undefined,
        })
      ) {
        return;
      }
      await this.publish(context, namespacePath, suffix, undefined, "append", path);
      return;
    }
    if (existing === undefined) {
      await this.publish(context, namespacePath, suffix, undefined, "append", path);
      return;
    }
    if (existing.kind === "directory") {
      throw fsError("EISDIR", "illegal operation on a directory", "append", path);
    }
    const sizeBytes = existing.file?.sizeBytes ?? 0;
    if (sizeBytes > this.maxAppendSourceBytes) {
      throw this.limitError(
        "EFBIG",
        `append would rewrite a LoonFS file larger than the configured ${this.maxAppendSourceBytes}-byte limit; use /tmp for scratch append or publish a complete replacement`,
        "append",
        path,
      );
    }
    const read = await this.request(() => this.backend.readFile(namespacePath), "append", path);
    this.context?.countRead(read.bytes.byteLength);
    if (read.bytes.byteLength > this.maxAppendSourceBytes) {
      throw this.limitError(
        "EFBIG",
        `append read ${read.bytes.byteLength} bytes, exceeding the configured ${this.maxAppendSourceBytes}-byte source limit; retry against the current revision or publish a complete replacement`,
        "append",
        path,
      );
    }
    if (suffix.byteLength > this.maxWriteBytes - read.bytes.byteLength) {
      throw this.limitError(
        "EFBIG",
        `append would write ${read.bytes.byteLength + suffix.byteLength} bytes and the configured write limit is ${this.maxWriteBytes}`,
        "append",
        path,
      );
    }
    const combined = new Uint8Array(read.bytes.byteLength + suffix.byteLength);
    combined.set(read.bytes, 0);
    combined.set(suffix, read.bytes.byteLength);
    await this.publish(context, namespacePath, combined, read.entry, "append", path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const context = this.writable("mkdir", path);
    const namespacePath = this.namespacePath(path, "mkdir");
    await this.materializeHeldWrite(namespacePath);
    await this.request(
      () =>
        this.backend.createDirectory(namespacePath, {
          parents: options?.recursive ?? false,
          commit: context.mintCommit(path),
        }),
      "mkdir",
      path,
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const context = this.writable("rm", path);
    const namespacePath = this.namespacePath(path, "rm");
    await this.materializeHeldWrite(namespacePath);
    const existing = await this.optionalEntry(namespacePath, "rm", path);
    if (existing === undefined) {
      if (options?.force) {
        return;
      }
      throw fsError("ENOENT", "no such file or directory", "rm", path);
    }
    try {
      await this.request(
        () =>
          this.backend.deletePath(namespacePath, {
            recursive: options?.recursive ?? false,
            expectedInodeId: existing.inodeId,
            commit: context.mintCommit(path),
          }),
        "rm",
        path,
      );
    } catch (error) {
      // Deleted by another writer is the asked-for outcome.
      if ((error as { code?: string }).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const context = this.writable("cp", src);
    const sourcePath = this.namespacePath(src, "cp");
    await this.materializeHeldWrite(sourcePath);
    const destinationPath = this.namespacePath(dest, "cp");
    context.clearHeldWrite(destinationPath);
    const source = await this.statEntry(sourcePath, "cp", src);
    if (source.kind === "file") {
      await this.copyOne(context, sourcePath, destinationPath, src, dest);
      return;
    }
    if (!options?.recursive) {
      throw fsError("EISDIR", "illegal operation on a directory", "cp", src);
    }
    await this.copyTree(context, src, dest);
  }

  async mv(src: string, dest: string): Promise<void> {
    const context = this.writable("rename", src);
    const sourcePath = this.namespacePath(src, "rename");
    const destinationPath = this.namespacePath(dest, "rename");
    await this.materializeHeldWrite(sourcePath);
    context.clearHeldWrite(destinationPath);
    const destination = await this.optionalEntry(destinationPath, "rename", dest);
    const commit = context.mintCommit(src);
    await this.request(
      () =>
        this.backend.movePath(
          sourcePath,
          destinationPath,
          guardedDestinationOptions(destination, commit),
        ),
      "rename",
      src,
    );
  }

  async chmod(path: string, _mode: number): Promise<void> {
    throw fsError(
      "ENOTSUP",
      "LoonFS has no permission bits; the mode shown by stat is display compatibility only",
      "chmod",
      path,
    );
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw fsError("ENOTSUP", "LoonFS has no symbolic links", "symlink", linkPath);
  }

  async link(_existingPath: string, newPath: string): Promise<void> {
    throw fsError("ENOTSUP", "LoonFS has no hard links", "link", newPath);
  }

  async readlink(path: string): Promise<string> {
    throw fsError("ENOTSUP", "LoonFS has no symbolic links", "readlink", path);
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw fsError("ENOTSUP", "LoonFS timestamps are set by commits, not by utimes", "utimes", path);
  }

  async settleHeldWrites(options: { flushExistingTruncates: boolean }): Promise<{
    failures: Array<{ path: string; error: Error }>;
    droppedTruncates: string[];
  }> {
    const failures: Array<{ path: string; error: Error }> = [];
    const droppedTruncates: string[] = [];
    for (const { namespacePath, virtualPath, existing } of this.context?.takeHeldWrites() ?? []) {
      if (existing !== undefined && !options.flushExistingTruncates) {
        droppedTruncates.push(virtualPath);
        continue;
      }
      try {
        const context = this.writable("write", virtualPath);
        if (existing?.kind === "directory") {
          throw fsError("EISDIR", "illegal operation on a directory", "write", virtualPath);
        }
        await this.publish(
          context,
          namespacePath,
          new Uint8Array(0),
          existing,
          "write",
          virtualPath,
        );
      } catch (error) {
        failures.push({
          path: virtualPath,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return { failures, droppedTruncates };
  }

  discardHeldWrites(): string[] {
    return (this.context?.takeHeldWrites() ?? []).map(({ virtualPath }) => virtualPath);
  }

  private heldDirectoryNames(namespacePath: string, existingNames: string[]): string[] {
    const names = new Set(existingNames);
    const heldNames: string[] = [];
    for (const held of this.context?.heldWriteEntries() ?? []) {
      if (
        held.existing !== undefined ||
        parentNamespacePath(held.namespacePath) !== namespacePath
      ) {
        continue;
      }
      const name = held.namespacePath.slice(held.namespacePath.lastIndexOf("/") + 1);
      if (!names.has(name)) {
        names.add(name);
        heldNames.push(name);
      }
    }
    return heldNames;
  }

  private async assertParentDirectory(
    namespacePath: string,
    syscall: string,
    path: string,
  ): Promise<void> {
    const parentPath = parentNamespacePath(namespacePath);
    if (parentPath === undefined) {
      return;
    }
    const parent = await this.optionalEntry(parentPath, syscall, path);
    if (parent === undefined) {
      throw fsError("ENOENT", "no such file or directory", syscall, path);
    }
    if (parent.kind !== "directory") {
      throw fsError("ENOTDIR", "not a directory", syscall, path);
    }
  }

  private async materializeHeldWrite(namespacePath: string): Promise<void> {
    const held = this.context?.takeHeldWrite(namespacePath);
    if (held === undefined) {
      return;
    }
    const context = this.writable("write", held.virtualPath);
    await this.publish(
      context,
      namespacePath,
      new Uint8Array(0),
      held.existing,
      "write",
      held.virtualPath,
    );
  }

  private async publish(
    context: MutationContext,
    namespacePath: string,
    bytes: Uint8Array,
    existing: LoonFsEntry | undefined,
    syscall: string,
    path: string,
  ): Promise<void> {
    if (existing?.kind === "directory") {
      throw fsError("EISDIR", "illegal operation on a directory", syscall, path);
    }
    if (bytes.byteLength > this.maxWriteBytes) {
      throw this.limitError(
        "EFBIG",
        `write is ${bytes.byteLength} bytes and the configured write limit is ${this.maxWriteBytes}`,
        syscall,
        path,
      );
    }
    const revisionNo = existing?.file?.revisionNo;
    const commit = context.mintCommit(path);
    await this.request(
      () =>
        this.backend.writeFile(
          namespacePath,
          bytes,
          existing === undefined
            ? { behavior: "no-replace" as WriteBehavior, commit }
            : {
                behavior: "replace" as WriteBehavior,
                expectedInodeId: existing.inodeId,
                ...(revisionNo !== undefined ? { expectedRevisionNo: revisionNo } : {}),
                commit,
              },
        ),
      syscall,
      path,
    );
    context.countWritten(bytes.byteLength);
  }

  private async copyOne(
    context: MutationContext,
    sourcePath: string,
    destinationPath: string,
    src: string,
    dest: string,
  ): Promise<void> {
    const destination = await this.optionalEntry(destinationPath, "cp", dest);
    const commit = context.mintCommit(dest);
    await this.request(
      () =>
        this.backend.copyFile(
          sourcePath,
          destinationPath,
          guardedDestinationOptions(destination, commit),
        ),
      "cp",
      src,
    );
  }

  private async copyTree(context: MutationContext, src: string, dest: string): Promise<void> {
    await this.request(
      () =>
        this.backend.createDirectory(this.namespacePath(dest, "cp"), {
          parents: true,
          commit: context.mintCommit(dest),
        }),
      "cp",
      dest,
    );
    for (const entry of await this.listAll(src)) {
      const childSrc = `${src}/${entry.name}`;
      const childDest = `${dest}/${entry.name}`;
      if (entry.kind === "directory") {
        await this.copyTree(context, childSrc, childDest);
      } else {
        await this.copyOne(
          context,
          this.namespacePath(childSrc, "cp"),
          this.namespacePath(childDest, "cp"),
          childSrc,
          childDest,
        );
      }
    }
  }

  private writable(syscall: string, path: string): MutationContext {
    if (this.access !== "read-write" || this.context === undefined) {
      throw fsError("EROFS", "the workspace was attached read-only", syscall, path);
    }
    return this.context;
  }

  private limitError(
    code: string,
    description: string,
    syscall: string,
    path: string,
  ): WorkspaceFsError {
    const error = fsError(code, description, syscall, path);
    this.context?.noteLimit(error.message);
    return error;
  }

  private namespacePath(path: string, syscall: string): string {
    return toNamespacePath(normalizeVirtualPath(path, syscall), this.namespaceRoot);
  }

  private async request<T>(call: () => Promise<T>, syscall: string, path: string): Promise<T> {
    this.context?.countRequest(syscall, path);
    try {
      return await call();
    } catch (error) {
      throw mapBackendError(error, syscall, path);
    }
  }

  private async statEntry(
    namespacePath: string,
    syscall: string,
    virtualPath: string,
  ): Promise<LoonFsEntry> {
    return this.request(() => this.backend.stat(namespacePath), syscall, virtualPath);
  }

  private async optionalEntry(
    namespacePath: string,
    syscall: string,
    virtualPath: string,
  ): Promise<LoonFsEntry | undefined> {
    this.context?.countRequest(syscall, virtualPath);
    try {
      return await this.backend.stat(namespacePath);
    } catch (error) {
      if (isBackendCondition(error, "not_found")) {
        return undefined;
      }
      throw mapBackendError(error, syscall, virtualPath);
    }
  }

  private async listAll(path: string): Promise<LoonFsEntry[]> {
    const namespacePath = this.namespacePath(path, "scandir");
    const entries: LoonFsEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.request(
        () =>
          this.backend.listDirectoryPage(
            namespacePath,
            cursor === undefined
              ? { limit: this.directoryPageSize }
              : { limit: this.directoryPageSize, cursor },
          ),
        "scandir",
        path,
      );
      entries.push(...page.entries);
      if (entries.length > this.maxDirectoryEntries) {
        throw this.limitError(
          "E2BIG",
          `directory exceeds the configured ${this.maxDirectoryEntries}-entry listing limit; narrow the operation`,
          "scandir",
          path,
        );
      }
      if (page.nextCursor === undefined) {
        return entries;
      }
      if (page.entries.length === 0 || seenCursors.has(page.nextCursor)) {
        throw fsError(
          "EIO",
          "the LoonFS backend returned a non-advancing directory cursor",
          "scandir",
          path,
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  private namespaceIdOnce(): Promise<string> {
    this.namespaceId ??= this.backend.getNamespace().then((info) => info.namespaceId);
    return this.namespaceId;
  }
}

function guardedDestinationOptions(
  destination: LoonFsEntry | undefined,
  commit: Parameters<LoonFsBackend["movePath"]>[2]["commit"],
): Parameters<LoonFsBackend["movePath"]>[2] {
  if (destination === undefined) {
    return { behavior: "no-replace", commit };
  }
  if (destination.kind === "directory") {
    return { behavior: "replace", commit };
  }
  return {
    behavior: "replace",
    expectedDestinationInodeId: destination.inodeId,
    ...(destination.file?.revisionNo !== undefined
      ? { expectedDestinationRevisionNo: destination.file.revisionNo }
      : {}),
    commit,
  };
}

function encodeContent(content: FileContent, options?: WriteFileOptions | TextEncodingName): Uint8Array {
  if (typeof content !== "string") {
    return content;
  }
  const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
  return Buffer.from(content, normalizeEncoding(encoding));
}

function normalizeEncoding(encoding: TextEncodingName | null): BufferEncoding {
  if (encoding === null || encoding === "utf-8") {
    return "utf8";
  }
  if (encoding === "binary") {
    return "latin1";
  }
  return encoding;
}

function parentNamespacePath(namespacePath: string): string | undefined {
  if (namespacePath === "/") {
    return undefined;
  }
  return namespacePath.slice(0, namespacePath.lastIndexOf("/")) || "/";
}
