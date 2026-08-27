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

interface FakeFile {
  kind: "file";
  name: string;
  inodeId: string;
  createdAtMs: number;
  revisionNo: number;
  committedAtMs: number;
  bytes: Uint8Array;
}

interface FakeDirectory {
  kind: "directory";
  name: string;
  inodeId: string;
  createdAtMs: number;
  children: Map<string, FakeNode>;
}

type FakeNode = FakeFile | FakeDirectory;

/**
 * A deterministic in-memory LoonFS namespace: same operation sequence, same
 * receipts. Guards and commit-id replay behave like the server so adapter
 * tests exercise real conflict shapes without a deployment.
 */
export class FakeLoonFsBackend implements LoonFsBackend {
  private readonly namespaceId: string;
  private readonly root: FakeDirectory;
  private readonly applied = new Map<string, MutationReceipt>();
  private headSeq = 0;
  private inodeCounter = 1;
  private tick = 0;
  private serverGrep: { pageSize: number; tailScanned: boolean } | undefined;

  constructor(options?: { namespaceId?: string }) {
    this.namespaceId = options?.namespaceId ?? "ns_fake";
    this.root = {
      kind: "directory",
      name: "",
      inodeId: "ino_1",
      createdAtMs: this.clock(),
      children: new Map(),
    };
  }

  seedDirectory(path: string): void {
    const segments = this.segments(path);
    let directory = this.root;
    for (const segment of segments) {
      directory = this.enterOrCreate(directory, segment);
    }
  }

  seedFile(path: string, content: string | Uint8Array): void {
    const segments = this.segments(path);
    const name = segments.pop();
    if (name === undefined) {
      throw new LoonFsBackendError("invalid_path", "cannot seed the root as a file");
    }
    let directory = this.root;
    for (const segment of segments) {
      directory = this.enterOrCreate(directory, segment);
    }
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const existing = directory.children.get(name);
    if (existing?.kind === "directory") {
      throw new LoonFsBackendError("is_a_directory", `${path} is a directory`);
    }
    directory.children.set(name, {
      kind: "file",
      name,
      inodeId: existing?.inodeId ?? this.mintInode(),
      createdAtMs: existing?.createdAtMs ?? this.clock(),
      revisionNo: existing ? existing.revisionNo + 1 : 1,
      committedAtMs: this.clock(),
      bytes,
    });
    this.headSeq += 1;
  }

  enableServerGrep(options?: { pageSize?: number; tailScanned?: boolean }): void {
    this.serverGrep = {
      pageSize: Math.max(1, options?.pageSize ?? 100),
      tailScanned: options?.tailScanned ?? true,
    };
  }

  async getCapabilities(): Promise<LoonFsCapabilities> {
    return { serverGrep: this.serverGrep !== undefined, changeFeed: false, attributes: false };
  }

  async grepNamespace(query: GrepQuery): Promise<GrepPage> {
    const grep = this.serverGrep;
    if (grep === undefined) {
      throw new LoonFsBackendError("unsupported", "content search is not enabled");
    }
    const root = this.resolve(query.pathPrefix ?? "/");
    if (root.kind !== "directory") {
      throw new LoonFsBackendError("not_a_directory", `${query.pathPrefix} is not a directory`);
    }
    const regex = new RegExp(query.pattern, query.caseInsensitive ? "i" : "");
    const matches: GrepPage["matches"] = [];
    const walk = (directory: FakeDirectory, prefix: string) => {
      for (const name of [...directory.children.keys()].sort()) {
        const child = directory.children.get(name)!;
        const path = prefix === "/" ? `/${name}` : `${prefix}/${name}`;
        if (child.kind === "directory") {
          walk(child, path);
          continue;
        }
        const lines = new TextDecoder().decode(child.bytes).split("\n");
        lines.forEach((line, index) => {
          if (regex.test(line)) {
            matches.push({ path, lineNo: index + 1, line, lineTruncated: false });
          }
        });
      }
    };
    walk(root, query.pathPrefix ?? "/");
    let start = 0;
    if (query.cursor !== undefined) {
      const [cursorPath, cursorLine] = query.cursor.split("\u0000");
      start = matches.findIndex(
        (match) =>
          match.path > cursorPath! ||
          (match.path === cursorPath && match.lineNo > Number(cursorLine)),
      );
      if (start < 0) {
        start = matches.length;
      }
    }
    const window = matches.slice(start, start + grep.pageSize);
    const page: GrepPage = { matches: window, tailScanned: grep.tailScanned };
    const last = window[window.length - 1];
    if (last !== undefined && start + grep.pageSize < matches.length) {
      page.nextCursor = `${last.path}\u0000${last.lineNo}`;
    }
    return page;
  }

  async getNamespace(): Promise<LoonFsNamespaceInfo> {
    return { namespaceId: this.namespaceId, headSeq: this.headSeq };
  }

  async stat(path: string): Promise<LoonFsEntry> {
    return this.entry(path, this.resolve(path));
  }

  async listDirectoryPage(
    path: string,
    options: { cursor?: string; limit: number },
  ): Promise<ListDirectoryPage> {
    const node = this.resolve(path);
    if (node.kind !== "directory") {
      throw new LoonFsBackendError("not_a_directory", `${path} is not a directory`);
    }
    const limit = Math.max(1, options.limit);
    const names = [...node.children.keys()].sort();
    const start = options.cursor === undefined ? 0 : names.findIndex((name) => name > options.cursor!);
    const window = start < 0 ? [] : names.slice(start, start + limit);
    const entries = window.map((name) =>
      this.entry(path + "/" + name, node.children.get(name)!),
    );
    const page: ListDirectoryPage = { entries, headSeq: this.headSeq };
    const lastName = window[window.length - 1];
    if (lastName !== undefined && start >= 0 && start + limit < names.length) {
      page.nextCursor = lastName;
    }
    return page;
  }

  async readFile(path: string): Promise<{ bytes: Uint8Array; entry: LoonFsEntry }> {
    const node = this.resolve(path);
    if (node.kind !== "file") {
      throw new LoonFsBackendError("is_a_directory", `${path} is a directory`);
    }
    return { bytes: node.bytes.slice(), entry: this.entry(path, node) };
  }

  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: { behavior: WriteBehavior; expectedRevisionNo?: number; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutate(options.commit, () => {
      const { directory, name } = this.parentOf(path);
      const existing = directory.children.get(name);
      if (existing?.kind === "directory") {
        throw new LoonFsBackendError("is_a_directory", `${path} is a directory`);
      }
      if (options.behavior === "no-replace" && existing) {
        throw new LoonFsBackendError("destination_exists", `${path} already exists`);
      }
      if (options.expectedRevisionNo !== undefined && existing?.revisionNo !== options.expectedRevisionNo) {
        throw new LoonFsBackendError("stale_revision", `${path} changed after it was read`);
      }
      const written: FakeFile = {
        kind: "file",
        name,
        inodeId: existing?.inodeId ?? this.mintInode(),
        createdAtMs: existing?.createdAtMs ?? this.clock(),
        revisionNo: existing ? existing.revisionNo + 1 : 1,
        committedAtMs: this.clock(),
        bytes: bytes.slice(),
      };
      directory.children.set(name, written);
      return this.entry(path, written);
    });
  }

  async createDirectory(
    path: string,
    options: { parents: boolean; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutate(options.commit, () => {
      const segments = this.segments(path);
      const name = segments.pop();
      if (name === undefined) {
        throw new LoonFsBackendError("destination_exists", "the root already exists");
      }
      let directory = this.root;
      for (const segment of segments) {
        const next = directory.children.get(segment);
        if (next === undefined) {
          if (!options.parents) {
            throw new LoonFsBackendError("not_found", `${segment} does not exist`);
          }
          directory = this.enterOrCreate(directory, segment);
          continue;
        }
        if (next.kind !== "directory") {
          throw new LoonFsBackendError("not_a_directory", `${segment} is not a directory`);
        }
        directory = next;
      }
      const existing = directory.children.get(name);
      if (existing !== undefined) {
        if (options.parents && existing.kind === "directory") {
          return this.entry(path, existing);
        }
        throw new LoonFsBackendError("destination_exists", `${path} already exists`);
      }
      const created: FakeDirectory = {
        kind: "directory",
        name,
        inodeId: this.mintInode(),
        createdAtMs: this.clock(),
        children: new Map(),
      };
      directory.children.set(name, created);
      return this.entry(path, created);
    });
  }

  async deletePath(
    path: string,
    options: { recursive: boolean; expectedInodeId?: string; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutate(options.commit, () => {
      const { directory, name } = this.parentOf(path);
      const node = directory.children.get(name);
      if (node === undefined) {
        throw new LoonFsBackendError("not_found", `${path} does not exist`);
      }
      if (options.expectedInodeId !== undefined && node.inodeId !== options.expectedInodeId) {
        throw new LoonFsBackendError("raced_binding", `${path} was rebound after it was read`);
      }
      if (node.kind === "directory" && node.children.size > 0 && !options.recursive) {
        throw new LoonFsBackendError("directory_not_empty", `${path} is not empty`);
      }
      directory.children.delete(name);
      return undefined;
    });
  }

  async movePath(
    fromPath: string,
    toPath: string,
    options: { behavior: WriteBehavior; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutate(options.commit, () => {
      const from = this.parentOf(fromPath);
      const node = from.directory.children.get(from.name);
      if (node === undefined) {
        throw new LoonFsBackendError("not_found", `${fromPath} does not exist`);
      }
      if (node.kind === "directory" && this.isWithin(toPath, fromPath)) {
        throw new LoonFsBackendError("invalid_path", `${toPath} is inside ${fromPath}`);
      }
      const to = this.parentOf(toPath);
      this.claimDestination(to.directory, to.name, toPath, options.behavior);
      from.directory.children.delete(from.name);
      node.name = to.name;
      to.directory.children.set(to.name, node);
      return this.entry(toPath, node);
    });
  }

  async copyFile(
    fromPath: string,
    toPath: string,
    options: { behavior: WriteBehavior; commit: MutationCommit },
  ): Promise<MutationReceipt> {
    return this.mutate(options.commit, () => {
      const source = this.resolve(fromPath);
      if (source.kind !== "file") {
        throw new LoonFsBackendError("is_a_directory", `${fromPath} is a directory`);
      }
      const to = this.parentOf(toPath);
      const displaced = this.claimDestination(to.directory, to.name, toPath, options.behavior);
      const copied: FakeFile = {
        kind: "file",
        name: to.name,
        inodeId: displaced?.kind === "file" ? displaced.inodeId : this.mintInode(),
        createdAtMs: displaced?.kind === "file" ? displaced.createdAtMs : this.clock(),
        revisionNo: displaced?.kind === "file" ? displaced.revisionNo + 1 : 1,
        committedAtMs: this.clock(),
        bytes: source.bytes.slice(),
      };
      to.directory.children.set(to.name, copied);
      return this.entry(toPath, copied);
    });
  }

  /** Replays of an applied commit answer the recorded receipt without re-checking guards. */
  private async mutate(
    commit: MutationCommit,
    apply: () => LoonFsEntry | undefined,
  ): Promise<MutationReceipt> {
    const replayed = this.applied.get(commit.commitId);
    if (replayed !== undefined) {
      return replayed;
    }
    const entry = apply();
    this.headSeq += 1;
    const receipt: MutationReceipt = { headSeq: this.headSeq };
    if (entry !== undefined) {
      receipt.entry = entry;
    }
    this.applied.set(commit.commitId, receipt);
    return receipt;
  }

  private claimDestination(
    directory: FakeDirectory,
    name: string,
    path: string,
    behavior: WriteBehavior,
  ): FakeNode | undefined {
    const occupant = directory.children.get(name);
    if (occupant === undefined) {
      return undefined;
    }
    if (behavior === "no-replace") {
      throw new LoonFsBackendError("destination_exists", `${path} already exists`);
    }
    if (occupant.kind === "directory") {
      throw new LoonFsBackendError("is_a_directory", `${path} is a directory`);
    }
    return occupant;
  }

  private entry(path: string, node: FakeNode): LoonFsEntry {
    const normalized = this.segments(path);
    const entry: LoonFsEntry = {
      path: `/${normalized.join("/")}`,
      name: node.name,
      kind: node.kind,
      inodeId: node.inodeId,
      createdAtMs: node.createdAtMs,
    };
    if (node.kind === "file") {
      entry.file = {
        revisionNo: node.revisionNo,
        sizeBytes: node.bytes.byteLength,
        committedAtMs: node.committedAtMs,
      };
    }
    return entry;
  }

  private resolve(path: string): FakeNode {
    let node: FakeNode = this.root;
    for (const segment of this.segments(path)) {
      if (node.kind !== "directory") {
        throw new LoonFsBackendError("not_a_directory", `${segment} is not a directory`);
      }
      const next: FakeNode | undefined = node.children.get(segment);
      if (next === undefined) {
        throw new LoonFsBackendError("not_found", `${path} does not exist`);
      }
      node = next;
    }
    return node;
  }

  private parentOf(path: string): { directory: FakeDirectory; name: string } {
    const segments = this.segments(path);
    const name = segments.pop();
    if (name === undefined) {
      throw new LoonFsBackendError("invalid_path", "the root cannot be a mutation target");
    }
    const parent = this.resolve(`/${segments.join("/")}`);
    if (parent.kind !== "directory") {
      throw new LoonFsBackendError("not_a_directory", `the parent of ${path} is not a directory`);
    }
    return { directory: parent, name };
  }

  private segments(path: string): string[] {
    if (!path.startsWith("/") || path.includes("\0")) {
      throw new LoonFsBackendError("invalid_path", `${JSON.stringify(path)} is not an absolute path`);
    }
    const segments = path.split("/").filter((segment) => segment.length > 0);
    for (const segment of segments) {
      if (segment === "." || segment === "..") {
        throw new LoonFsBackendError("invalid_path", `${path} must be normalized before the backend`);
      }
    }
    return segments;
  }

  private isWithin(path: string, ancestor: string): boolean {
    const inner = this.segments(path);
    const outer = this.segments(ancestor);
    return outer.length <= inner.length && outer.every((segment, i) => inner[i] === segment);
  }

  private enterOrCreate(directory: FakeDirectory, name: string): FakeDirectory {
    const existing = directory.children.get(name);
    if (existing !== undefined) {
      if (existing.kind !== "directory") {
        throw new LoonFsBackendError("not_a_directory", `${name} is not a directory`);
      }
      return existing;
    }
    const created: FakeDirectory = {
      kind: "directory",
      name,
      inodeId: this.mintInode(),
      createdAtMs: this.clock(),
      children: new Map(),
    };
    directory.children.set(name, created);
    return created;
  }

  private mintInode(): string {
    this.inodeCounter += 1;
    return `ino_${this.inodeCounter}`;
  }

  private clock(): number {
    this.tick += 1;
    return 1_700_000_000_000 + this.tick * 1000;
  }
}
