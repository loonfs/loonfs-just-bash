import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LoonFsActor, SearchMode } from "../types.js";
import type { LoonFsEntry, MutationCommit } from "../backend/backend.js";
import { DEFAULT_WORKSPACE_LIMITS } from "../limits.js";
import { fsError } from "./errors.js";

export interface WorkspaceCounters {
  requests: number;
  mutations: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface MutationContextOptions {
  actor: LoonFsActor;
  message?: string;
  maxMutationsPerExec?: number;
  maxLoonFsRequestsPerExec?: number;
  maxReadBytesPerExec?: number;
  maxWriteBytesPerExec?: number;
}

export interface HeldWrite {
  virtualPath: string;
  existing: LoonFsEntry | undefined;
}

interface ExecutionState {
  counters: WorkspaceCounters;
  heldWrites: Map<string, HeldWrite>;
  limitNotes: string[];
  message: string | undefined;
  modes: SearchMode[];
  readFailures: Map<string, string>;
}

/**
 * Owns mutation provenance and the per-execution budgets just-bash cannot
 * see. One shell execution resets it; every backend call and minted commit
 * counts against it, and a spent budget fails the command instead of
 * letting work continue unbounded.
 */
export class MutationContext {
  readonly actor: LoonFsActor;
  readonly message: string;
  private readonly maxMutations: number;
  private readonly maxRequests: number;
  private readonly maxReadBytes: number;
  private readonly maxWriteBytes: number;
  private readonly executions = new AsyncLocalStorage<ExecutionState>();
  private fallbackState = emptyState();
  private lastState = this.fallbackState;

  constructor(options: MutationContextOptions) {
    this.actor = options.actor;
    this.message = options.message ?? "just-bash workspace mutation";
    this.maxMutations = options.maxMutationsPerExec ?? DEFAULT_WORKSPACE_LIMITS.maxMutationsPerExec;
    this.maxRequests =
      options.maxLoonFsRequestsPerExec ?? DEFAULT_WORKSPACE_LIMITS.maxLoonFsRequestsPerExec;
    this.maxReadBytes = options.maxReadBytesPerExec ?? DEFAULT_WORKSPACE_LIMITS.maxReadBytes;
    this.maxWriteBytes = options.maxWriteBytesPerExec ?? DEFAULT_WORKSPACE_LIMITS.maxWriteBytes;
  }

  /** Mints the commit identity one semantic mutation keeps across retries. */
  mintCommit(path: string): MutationCommit {
    const state = this.state();
    state.counters.mutations += 1;
    if (state.counters.mutations > this.maxMutations) {
      const error = fsError(
        "E2BIG",
        `this execution exceeded its ${this.maxMutations}-mutation budget`,
        "commit",
        path,
      );
      this.noteLimit(error.message);
      throw error;
    }
    return {
      commitId: `c_${randomUUID().replaceAll("-", "")}`,
      actor: this.actor,
      message: state.message ?? this.message,
    };
  }

  countRequest(syscall: string, path: string): void {
    const state = this.state();
    state.counters.requests += 1;
    if (state.counters.requests > this.maxRequests) {
      const error = fsError(
        "E2BIG",
        `this execution exceeded its ${this.maxRequests}-request budget`,
        syscall,
        path,
      );
      this.noteLimit(error.message);
      throw error;
    }
  }

  holdEmptyWrite(namespacePath: string, held: HeldWrite): boolean {
    const active = this.executions.getStore();
    if (active === undefined) {
      return false;
    }
    active.heldWrites.set(namespacePath, held);
    return true;
  }

  heldWrite(namespacePath: string): HeldWrite | undefined {
    return this.executions.getStore()?.heldWrites.get(namespacePath);
  }

  hasActiveExecution(): boolean {
    return this.executions.getStore() !== undefined;
  }

  clearHeldWrite(namespacePath: string): void {
    this.executions.getStore()?.heldWrites.delete(namespacePath);
  }

  takeHeldWrite(namespacePath: string): ({ namespacePath: string } & HeldWrite) | undefined {
    const active = this.executions.getStore();
    if (active === undefined) {
      return undefined;
    }
    const held = active.heldWrites.get(namespacePath);
    if (held === undefined) {
      return undefined;
    }
    active.heldWrites.delete(namespacePath);
    return { namespacePath, ...held };
  }

  takeHeldWrites(): Array<{ namespacePath: string } & HeldWrite> {
    const active = this.executions.getStore();
    if (active === undefined) {
      return [];
    }
    const entries = [...active.heldWrites].map(([namespacePath, held]) => ({
      namespacePath,
      ...held,
    }));
    active.heldWrites.clear();
    return entries;
  }

  heldWriteEntries(): Array<{ namespacePath: string } & HeldWrite> {
    const active = this.executions.getStore();
    if (active === undefined) {
      return [];
    }
    return [...active.heldWrites].map(([namespacePath, held]) => ({ namespacePath, ...held }));
  }

  noteLimit(message: string): void {
    const notes = this.state().limitNotes;
    if (!notes.includes(message)) {
      notes.push(message);
    }
  }

  limitNotes(): string[] {
    return [...this.state().limitNotes];
  }

  noteReadFailure(virtualPath: string, text: string): void {
    this.state().readFailures.set(virtualPath, text);
  }

  readFailures(): Array<[string, string]> {
    return [...this.state().readFailures];
  }

  reserveRead(bytes: number, syscall: string, path: string): void {
    this.consumeBytes("bytesRead", bytes, this.maxReadBytes, "read", syscall, path);
  }

  settleRead(reservedBytes: number, actualBytes: number, syscall: string, path: string): void {
    const difference = actualBytes - reservedBytes;
    if (difference > 0) {
      this.consumeBytes("bytesRead", difference, this.maxReadBytes, "read", syscall, path);
    } else if (difference < 0) {
      this.state().counters.bytesRead += difference;
    }
  }

  releaseRead(bytes: number): void {
    this.state().counters.bytesRead = Math.max(0, this.state().counters.bytesRead - bytes);
  }

  /** @deprecated Filesystem adapters should reserve before starting the read. */
  countRead(bytes: number): void {
    this.reserveRead(bytes, "read", "/");
  }

  reserveWrite(bytes: number, syscall: string, path: string): void {
    this.consumeBytes("bytesWritten", bytes, this.maxWriteBytes, "write", syscall, path);
  }

  releaseWrite(bytes: number): void {
    this.state().counters.bytesWritten = Math.max(0, this.state().counters.bytesWritten - bytes);
  }

  /** @deprecated Filesystem adapters should reserve before starting the write. */
  countWritten(bytes: number): void {
    this.reserveWrite(bytes, "write", "/");
  }

  snapshot(): WorkspaceCounters {
    return { ...this.state().counters };
  }

  reset(): void {
    const active = this.executions.getStore();
    if (active !== undefined) {
      active.counters = emptyCounters();
      active.heldWrites.clear();
      active.limitNotes = [];
      active.modes = [];
      active.readFailures.clear();
      return;
    }
    this.fallbackState = emptyState();
    this.lastState = this.fallbackState;
  }

  /** Starts a direct-adapter execution outside runExecution(). */
  beginExecution(message?: string): void {
    this.fallbackState = emptyState(message);
    this.lastState = this.fallbackState;
  }

  /** Isolates counters, search modes, and attribution across late async completions. */
  runExecution<T>(message: string | undefined, run: () => Promise<T>): Promise<T> {
    const state = emptyState(message);
    this.lastState = state;
    return this.executions.run(state, run);
  }

  recordSearchMode(mode: SearchMode): void {
    this.state().modes.push(mode);
  }

  searchModes(): SearchMode[] {
    return [...this.state().modes];
  }

  private state(): ExecutionState {
    return this.executions.getStore() ?? this.lastState;
  }

  private consumeBytes(
    counter: "bytesRead" | "bytesWritten",
    bytes: number,
    limit: number,
    kind: "read" | "write",
    syscall: string,
    path: string,
  ): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw fsError("EIO", "invalid byte count from the filesystem backend", syscall, path);
    }
    const state = this.state();
    const next = state.counters[counter] + bytes;
    if (next > limit) {
      const error = fsError(
        "EFBIG",
        `this execution exceeded its ${limit}-byte aggregate ${kind} budget`,
        syscall,
        path,
      );
      this.noteLimit(error.message);
      throw error;
    }
    state.counters[counter] = next;
  }
}

function emptyState(message?: string): ExecutionState {
  return {
    counters: emptyCounters(),
    heldWrites: new Map(),
    limitNotes: [],
    message,
    modes: [],
    readFailures: new Map(),
  };
}

function emptyCounters(): WorkspaceCounters {
  return { requests: 0, mutations: 0, bytesRead: 0, bytesWritten: 0 };
}
