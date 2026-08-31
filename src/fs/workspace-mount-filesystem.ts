import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import { MountableFs } from "just-bash";
import { fsError } from "./errors.js";
import { normalizeVirtualPath } from "./path.js";

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export interface WorkspaceMountFileSystemOptions {
  base: IFileSystem;
  mountPoint: string;
  workspace: IFileSystem;
}

/**
 * Routes the durable workspace and ephemeral /tmp mount while refusing the
 * otherwise-surprising writable in-memory root exposed by MountableFs.
 */
export class WorkspaceMountFileSystem extends MountableFs {
  private readonly workspaceMountPoint: string;

  constructor(options: WorkspaceMountFileSystemOptions) {
    super({
      base: options.base,
      mounts: [{ mountPoint: options.mountPoint, filesystem: options.workspace }],
    });
    this.workspaceMountPoint = normalizeVirtualPath(options.mountPoint, "mount");
  }

  override async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    if (isNullDevice(path)) {
      return;
    }
    this.assertWritable(path, "write");
    await super.writeFile(path, content, options);
  }

  override async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    if (isNullDevice(path)) {
      return;
    }
    this.assertWritable(path, "append");
    await super.appendFile(path, content, options);
  }

  override async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.assertWritable(path, "mkdir");
    await super.mkdir(path, options);
  }

  override async rm(path: string, options?: RmOptions): Promise<void> {
    this.assertWritable(path, "rm");
    await super.rm(path, options);
  }

  override async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.assertWritable(dest, "cp");
    await super.cp(src, dest, options);
  }

  override async mv(src: string, dest: string): Promise<void> {
    this.assertWritable(src, "rename");
    this.assertWritable(dest, "rename");
    await super.mv(src, dest);
  }

  override async chmod(path: string, mode: number): Promise<void> {
    this.assertWritable(path, "chmod");
    await super.chmod(path, mode);
  }

  override async symlink(target: string, linkPath: string): Promise<void> {
    this.assertWritable(linkPath, "symlink");
    await super.symlink(target, linkPath);
  }

  override async link(existingPath: string, newPath: string): Promise<void> {
    this.assertWritable(newPath, "link");
    await super.link(existingPath, newPath);
  }

  override async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.assertWritable(path, "utimes");
    await super.utimes(path, atime, mtime);
  }

  private assertWritable(path: string, syscall: string): void {
    const normalized = normalizeVirtualPath(path, syscall);
    if (isAtOrBelow(normalized, "/tmp") || isAtOrBelow(normalized, this.workspaceMountPoint)) {
      return;
    }
    throw fsError(
      "EROFS",
      `only /tmp and ${this.workspaceMountPoint} are writable`,
      syscall,
      path,
    );
  }
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isNullDevice(path: string): boolean {
  return normalizeVirtualPath(path, "write") === "/dev/null";
}
