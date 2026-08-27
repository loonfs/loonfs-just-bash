import { randomUUID } from "node:crypto";
import type { LoonFsActor } from "../types.js";
import type { MutationCommit } from "../backend/backend.js";
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
  private counters: WorkspaceCounters = { requests: 0, mutations: 0, bytesRead: 0, bytesWritten: 0 };
  private currentMessage: string | undefined;

  constructor(options: MutationContextOptions) {
    this.actor = options.actor;
    this.message = options.message ?? "just-bash workspace mutation";
    this.maxMutations = options.maxMutationsPerExec ?? DEFAULT_WORKSPACE_LIMITS.maxMutationsPerExec;
    this.maxRequests =
      options.maxLoonFsRequestsPerExec ?? DEFAULT_WORKSPACE_LIMITS.maxLoonFsRequestsPerExec;
  }

  /** Mints the commit identity one semantic mutation keeps across retries. */
  mintCommit(path: string): MutationCommit {
    this.counters.mutations += 1;
    if (this.counters.mutations > this.maxMutations) {
      throw fsError(
        "E2BIG",
        `this execution exceeded its ${this.maxMutations}-mutation budget`,
        "commit",
        path,
      );
    }
    return {
      commitId: `c_${randomUUID().replaceAll("-", "")}`,
      actor: this.actor,
      message: this.currentMessage ?? this.message,
    };
  }

  countRequest(syscall: string, path: string): void {
    this.counters.requests += 1;
    if (this.counters.requests > this.maxRequests) {
      throw fsError(
        "E2BIG",
        `this execution exceeded its ${this.maxRequests}-request budget`,
        syscall,
        path,
      );
    }
  }

  countRead(bytes: number): void {
    this.counters.bytesRead += bytes;
  }

  countWritten(bytes: number): void {
    this.counters.bytesWritten += bytes;
  }

  snapshot(): WorkspaceCounters {
    return { ...this.counters };
  }

  reset(): void {
    this.counters = { requests: 0, mutations: 0, bytesRead: 0, bytesWritten: 0 };
  }

  /** One shell execution: fresh budgets, and its host-supplied message on every commit. */
  beginExecution(message?: string): void {
    this.reset();
    this.currentMessage = message;
  }
}
