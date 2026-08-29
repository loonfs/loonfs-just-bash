import { Bash, BashTransformPipeline, InMemoryFs, MountableFs, defineCommand } from "just-bash";
import type { LoonFsBackend } from "../backend/backend.js";
import { HttpLoonFsBackend } from "../backend/http-backend.js";
import { SessionBackend } from "../backend/session-backend.js";
import { grepRoutingPlugin } from "../commands/grep-routing.js";
import { loonfsGrepCommand } from "../commands/loonfs-grep.js";
import { isBackendCondition } from "../fs/errors.js";
import { LoonFsFileSystem } from "../fs/loonfs-filesystem.js";
import { MutationContext } from "../fs/mutation-context.js";
import { normalizeVirtualPath } from "../fs/path.js";
import { resolveWorkspaceLimits } from "../limits.js";
import type {
  CreateWorkspaceShellOptions,
  LoonFsWorkspaceShell,
  WorkspaceAccess,
  WorkspaceExecOptions,
  WorkspaceExecResult,
  WorkspaceExecutionSummary,
  WorkspaceInfo,
  WorkspaceLimits,
} from "../types.js";
import { WORKSPACE_COMMAND_ALLOWLIST } from "./command-policy.js";

/**
 * just-bash reports a filesystem error thrown while opening a redirection
 * target by rejecting exec(), so the shell wrapper translates every
 * rejection into an ordinary failed result instead of crashing the host.
 */
export async function createLoonFsWorkspaceShell(
  options: CreateWorkspaceShellOptions,
): Promise<LoonFsWorkspaceShell> {
  const access: WorkspaceAccess = options.access ?? "read-only";
  if (access !== "read-only" && access !== "read-write") {
    throw new Error("access must be either 'read-only' or 'read-write'");
  }
  const limits = resolveWorkspaceLimits(options.limits);
  const mountPoint = normalizeVirtualPath(options.mountPoint ?? "/workspace", "mount");
  if (mountPoint === "/") {
    throw new Error("mountPoint must name a directory below '/', such as '/workspace'");
  }
  const raw = resolveBackend(options);
  const namespace = await raw.getNamespace();
  const capabilities = await raw.getCapabilities();
  try {
    await raw.stat("/");
  } catch (error) {
    if (isBackendCondition(error, "unsupported")) {
      throw new Error(
        "the LoonFS server did not answer a current path read; this package needs a server speaking LoonFS API v0.3.x",
      );
    }
    throw error;
  }
  const context = new MutationContext({
    actor: options.actor,
    maxMutationsPerExec: limits.maxMutationsPerExec,
    maxLoonFsRequestsPerExec: limits.maxLoonFsRequestsPerExec,
  });
  const serverGrepOffered = capabilities.serverGrep && raw.grepNamespace !== undefined;
  const backend = new SessionBackend(raw);
  const workspaceFs = new LoonFsFileSystem({
    backend,
    access,
    context,
    ...(options.namespaceRoot !== undefined ? { namespaceRoot: options.namespaceRoot } : {}),
    maxReadBytes: limits.maxReadBytes,
    maxWriteBytes: limits.maxWriteBytes,
    maxAppendSourceBytes: limits.maxAppendSourceBytes,
    maxDirectoryEntries: limits.maxDirectoryEntries,
  });
  const scratchFs = new InMemoryFs();
  await scratchFs.mkdir("/tmp");
  const fs = new MountableFs({
    base: scratchFs,
    mounts: [{ mountPoint, filesystem: workspaceFs }],
  });
  const workspaceInfo = defineCommand("workspace-info", async () => {
    const head = await backend.getNamespace();
    const lines = [
      `namespace: ${namespace.namespaceId}`,
      `mount: ${mountPoint}`,
      `access: ${access}`,
      `head_seq: ${head.headSeq}`,
      "filesystem_model: durable revisioned workspace",
      "posix_compatible: false",
      "symlinks: unsupported",
      "hard_links: unsupported",
      "permissions: unsupported",
      "append: bounded whole-file replacement",
      `max_read_bytes: ${limits.maxReadBytes}`,
      `max_write_bytes: ${limits.maxWriteBytes}`,
      `max_append_source_bytes: ${limits.maxAppendSourceBytes}`,
      `max_directory_entries: ${limits.maxDirectoryEntries}`,
      `max_traversal_entries: ${limits.maxTraversalEntries}`,
      `max_command_count: ${limits.maxCommandCount}`,
      `max_loop_iterations: ${limits.maxLoopIterations}`,
      `max_mutations_per_exec: ${limits.maxMutationsPerExec}`,
      `max_loonfs_requests_per_exec: ${limits.maxLoonFsRequestsPerExec}`,
      `max_execution_time_ms: ${limits.maxExecutionTimeMs}`,
      `max_output_bytes: ${limits.maxOutputBytes}`,
    ];
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  });
  const serverGrep = serverGrepOffered;
  const bash = new Bash({
    fs,
    cwd: mountPoint,
    commands: WORKSPACE_COMMAND_ALLOWLIST,
    customCommands: [
      workspaceInfo,
      loonfsGrepCommand({
        backend,
        serverGrep,
        mountPoint,
        namespaceRoot: normalizeVirtualPath(options.namespaceRoot ?? "/", "mount"),
        context,
      }),
    ],
    executionLimitProfile: "hardened",
    executionLimits: {
      maxExecutionTimeMs: limits.maxExecutionTimeMs,
      maxOutputSize: limits.maxOutputBytes,
      maxInputBytes: 32 * 1024 * 1024,
      maxLiveBytes: 64 * 1024 * 1024,
      maxFileSystemBytes: 128 * 1024 * 1024,
      maxTraversalEntries: limits.maxTraversalEntries,
      maxTraversalDepth: 128,
      maxTraversalWork: 100_000,
      maxGlobOperations: 50_000,
      maxCommandCount: limits.maxCommandCount,
      maxLoopIterations: limits.maxLoopIterations,
      maxWorkUnits: 100_000,
    },
    // The defense-in-depth box hardens JS intrinsics to contain embedded
    // language runtimes; this shell registers none, and the box also breaks
    // any filesystem whose operations perform real network I/O. Containment
    // here is the allowlist, the absent runtimes, and the budgets.
    defenseInDepth: { enabled: false },
  });
  const routing = new BashTransformPipeline().use(
    grepRoutingPlugin({ routeToServer: serverGrep, mountPoint }),
  );
  return new WorkspaceShell(bash, backend, context, routing, {
    namespaceId: namespace.namespaceId,
    mountPoint,
    access,
    limits,
    workspace: workspaceFs,
    ...(options.onExecutionSummary !== undefined
      ? { onExecutionSummary: options.onExecutionSummary }
      : {}),
  });
}

interface WorkspaceIdentity {
  namespaceId: string;
  mountPoint: string;
  access: WorkspaceAccess;
  limits: WorkspaceLimits;
  workspace: LoonFsFileSystem;
  onExecutionSummary?: (summary: WorkspaceExecutionSummary) => void | Promise<void>;
}

class WorkspaceShell implements LoonFsWorkspaceShell {
  private readonly bash: Bash;
  private readonly backend: SessionBackend;
  private readonly context: MutationContext;
  private readonly routing: BashTransformPipeline<{ loonfsGrepRouting?: { routed: number; local: number } }>;
  private readonly identity: WorkspaceIdentity;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    bash: Bash,
    backend: SessionBackend,
    context: MutationContext,
    routing: BashTransformPipeline<{ loonfsGrepRouting?: { routed: number; local: number } }>,
    identity: WorkspaceIdentity,
  ) {
    this.bash = bash;
    this.backend = backend;
    this.context = context;
    this.routing = routing;
    this.identity = identity;
  }

  exec(script: string, options?: WorkspaceExecOptions): Promise<WorkspaceExecResult> {
    // Sampled at enqueue: an execution accepted before close() still runs.
    if (this.closed) {
      return Promise.reject(new Error("this workspace shell is closed"));
    }
    const run = this.queue.then(() => this.runSerialized(script, options));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSerialized(
    script: string,
    options?: WorkspaceExecOptions,
  ): Promise<WorkspaceExecResult> {
    return this.context.runExecution(options?.message, () => this.runExecution(script, options));
  }

  private async runExecution(
    script: string,
    options?: WorkspaceExecOptions,
  ): Promise<WorkspaceExecResult> {
    const startedAtMs = Date.now();
    const headSeqBefore = await this.observedHeadSeq();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let interpreterFailed = false;
    try {
      // Glob expansion walks live directory listings through the adapter, so
      // matches are always current and an over-limit listing fails the
      // pattern loudly as a literal instead of matching a partial set.
      const transformed = this.routing.transform(script);
      const localSearches = transformed.metadata.loonfsGrepRouting?.local ?? 0;
      for (let i = 0; i < localSearches; i += 1) {
        this.context.recordSearchMode("bounded_local");
      }
      const result = await this.bash.exec(transformed.script);
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
    } catch (error) {
      interpreterFailed = true;
      stderr = `${error instanceof Error ? error.message : String(error)}\n`;
      exitCode = 1;
    }
    // Interpreter limit aborts resolve as 124, or 126 with bash-prefixed stderr, so staged truncates must be dropped.
    const aborted =
      interpreterFailed || exitCode === 124 || (exitCode === 126 && stderr.includes("bash: "));
    if (aborted) {
      for (const path of this.identity.workspace.discardHeldWrites()) {
        const displayPath = this.workspacePath(path);
        stderr += `loonfs: the staged write to '${displayPath}' was discarded because the execution was interrupted\n`;
      }
    } else {
      for (const failure of await this.identity.workspace.settleHeldWrites()) {
        const displayPath = this.workspacePath(failure.path);
        stderr += `loonfs: the staged write to '${displayPath}' failed: ${failure.error.message}\n`;
        if (exitCode === 0) {
          exitCode = 1;
        }
      }
    }
    for (const note of this.context.limitNotes()) {
      stderr += `loonfs: ${note}\n`;
    }
    const headSeqAfter = await this.observedHeadSeq();
    const counters = this.context.snapshot();
    const searchModes = this.context.searchModes();
    if (this.identity.onExecutionSummary !== undefined) {
      try {
        const observed = this.identity.onExecutionSummary({
          namespaceId: this.identity.namespaceId,
          ...(options?.toolCallId !== undefined ? { toolCallId: options.toolCallId } : {}),
          ...(options?.message !== undefined ? { message: options.message } : {}),
          exitCode,
          durationMs: Date.now() - startedAtMs,
          ...(headSeqBefore !== undefined ? { headSeqBefore } : {}),
          ...(headSeqAfter !== undefined ? { headSeqAfter } : {}),
          requests: counters.requests,
          mutations: counters.mutations,
          bytesRead: counters.bytesRead,
          bytesWritten: counters.bytesWritten,
          searchModes: [...searchModes],
        });
        if (observed !== undefined) {
          void Promise.resolve(observed).catch(() => {});
        }
      } catch {
        // The host's observer must not affect the execution.
      }
    }
    return {
      stdout,
      stderr,
      exitCode,
      ...(headSeqBefore !== undefined ? { headSeqBefore } : {}),
      ...(headSeqAfter !== undefined ? { headSeqAfter } : {}),
      requests: counters.requests,
      mutations: counters.mutations,
      bytesRead: counters.bytesRead,
      bytesWritten: counters.bytesWritten,
      ...(searchModes.length > 0 ? { searchModes } : {}),
    };
  }

  /** Telemetry must never turn a completed execution into a rejection. */
  private async observedHeadSeq(): Promise<number | undefined> {
    try {
      return (await this.backend.getNamespace()).headSeq;
    } catch {
      return undefined;
    }
  }

  private workspacePath(path: string): string {
    return path === "/" ? this.identity.mountPoint : `${this.identity.mountPoint}${path}`;
  }

  /** Clears a fenced-writer latch and proves the deployment is reachable. */
  async refresh(): Promise<void> {
    await this.backend.getNamespace();
    this.backend.clearFence();
  }

  async info(): Promise<WorkspaceInfo> {
    return {
      namespaceId: this.identity.namespaceId,
      mountPoint: this.identity.mountPoint,
      access: this.identity.access,
      headSeq: (await this.backend.getNamespace()).headSeq,
      limits: { ...this.identity.limits },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}

function resolveBackend(options: CreateWorkspaceShellOptions): LoonFsBackend {
  if (options.backend !== undefined) {
    return options.backend;
  }
  if (options.client !== undefined && options.namespaceId !== undefined) {
    return new HttpLoonFsBackend({ client: options.client, namespaceId: options.namespaceId });
  }
  throw new Error("provide a backend, or a client together with a namespaceId");
}
