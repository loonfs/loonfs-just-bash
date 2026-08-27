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
import type { LoonFsBackend, LoonFsEntry } from "../backend/backend.js";
import { DEFAULT_WORKSPACE_LIMITS } from "../limits.js";
import { fsError, isBackendCondition, mapBackendError } from "./errors.js";
import { joinVirtualPaths, normalizeVirtualPath, toNamespacePath } from "./path.js";
import { statFromEntry } from "./stat-mapping.js";

export interface LoonFsFileSystemOptions {
  backend: LoonFsBackend;
  namespaceRoot?: string;
  maxReadBytes?: number;
  maxDirectoryEntries?: number;
  directoryPageSize?: number;
}

/**
 * The read side of the just-bash filesystem contract over one LoonFS
 * namespace. Mutations land in a later change; until then every write-shaped
 * method reports a read-only filesystem rather than pretending.
 */
export class LoonFsFileSystem implements IFileSystem {
  private readonly backend: LoonFsBackend;
  private readonly namespaceRoot: string;
  private readonly maxReadBytes: number;
  private readonly maxDirectoryEntries: number;
  private readonly directoryPageSize: number;
  private namespaceId: Promise<string> | undefined;

  constructor(options: LoonFsFileSystemOptions) {
    this.backend = options.backend;
    this.namespaceRoot = normalizeVirtualPath(options.namespaceRoot ?? "/", "mount");
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_WORKSPACE_LIMITS.maxReadBytes;
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
    const entry = await this.statEntry(namespacePath, "open", path);
    if (entry.kind === "directory") {
      throw fsError("EISDIR", "illegal operation on a directory", "read", path);
    }
    const sizeBytes = entry.file?.sizeBytes ?? 0;
    if (sizeBytes > this.maxReadBytes) {
      throw fsError(
        "EFBIG",
        `file is ${sizeBytes} bytes and the configured read limit is ${this.maxReadBytes}`,
        "read",
        path,
      );
    }
    try {
      return (await this.backend.readFile(namespacePath)).bytes;
    } catch (error) {
      throw mapBackendError(error, "read", path);
    }
  }

  async exists(path: string): Promise<boolean> {
    const namespacePath = this.namespacePath(path, "stat");
    try {
      await this.backend.stat(namespacePath);
      return true;
    } catch (error) {
      if (isBackendCondition(error, "not_found")) {
        return false;
      }
      throw mapBackendError(error, "stat", path);
    }
  }

  async stat(path: string): Promise<FsStat> {
    const namespacePath = this.namespacePath(path, "stat");
    const entry = await this.statEntry(namespacePath, "stat", path);
    return statFromEntry(entry, await this.namespaceIdOnce());
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.listAll(path)).map((entry) => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return (await this.listAll(path)).map((entry) => ({
      name: entry.name,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "directory",
      isSymbolicLink: false,
    }));
  }

  resolvePath(base: string, path: string): string {
    return joinVirtualPaths(base, path);
  }

  async realpath(path: string): Promise<string> {
    const virtual = normalizeVirtualPath(path, "realpath");
    await this.statEntry(toNamespacePath(virtual, this.namespaceRoot), "realpath", path);
    return virtual;
  }

  getAllPaths(): string[] {
    throw fsError(
      "ENOTSUP",
      "wildcard expansion needs the session path index, which this build does not provide yet; use an explicit path or bounded find",
      "glob",
      this.namespaceRoot,
    );
  }

  async writeFile(path: string, _content: FileContent, _options?: WriteFileOptions | TextEncodingName): Promise<void> {
    throw this.readOnly("write", path);
  }

  async appendFile(path: string, _content: FileContent, _options?: WriteFileOptions | TextEncodingName): Promise<void> {
    throw this.readOnly("append", path);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    throw this.readOnly("mkdir", path);
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    throw this.readOnly("rm", path);
  }

  async cp(src: string, _dest: string, _options?: CpOptions): Promise<void> {
    throw this.readOnly("cp", src);
  }

  async mv(src: string, _dest: string): Promise<void> {
    throw this.readOnly("rename", src);
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
    throw fsError(
      "ENOTSUP",
      "LoonFS timestamps are set by commits, not by utimes",
      "utimes",
      path,
    );
  }

  private readOnly(syscall: string, path: string): Error {
    return fsError(
      "EROFS",
      "this build of the LoonFS workspace adapter is read-only; mutations land in a later change",
      syscall,
      path,
    );
  }

  private namespacePath(path: string, syscall: string): string {
    return toNamespacePath(normalizeVirtualPath(path, syscall), this.namespaceRoot);
  }

  private async statEntry(
    namespacePath: string,
    syscall: string,
    virtualPath: string,
  ): Promise<LoonFsEntry> {
    try {
      return await this.backend.stat(namespacePath);
    } catch (error) {
      throw mapBackendError(error, syscall, virtualPath);
    }
  }

  private async listAll(path: string): Promise<LoonFsEntry[]> {
    const namespacePath = this.namespacePath(path, "scandir");
    const entries: LoonFsEntry[] = [];
    let cursor: string | undefined;
    try {
      for (;;) {
        const page = await this.backend.listDirectoryPage(
          namespacePath,
          cursor === undefined
            ? { limit: this.directoryPageSize }
            : { limit: this.directoryPageSize, cursor },
        );
        entries.push(...page.entries);
        if (entries.length > this.maxDirectoryEntries) {
          throw fsError(
            "E2BIG",
            `directory exceeds the configured ${this.maxDirectoryEntries}-entry listing limit; narrow the operation`,
            "scandir",
            path,
          );
        }
        if (page.nextCursor === undefined) {
          return entries;
        }
        cursor = page.nextCursor;
      }
    } catch (error) {
      throw mapBackendError(error, "scandir", path);
    }
  }

  private namespaceIdOnce(): Promise<string> {
    this.namespaceId ??= this.backend.getNamespace().then((info) => info.namespaceId);
    return this.namespaceId;
  }
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
