import { Bash, BashTransformPipeline, InMemoryFs, MountableFs, defineCommand } from "just-bash";
import type { LoonFsBackend } from "../backend/backend.js";
import { HttpLoonFsBackend } from "../backend/http-backend.js";
import { grepRoutingPlugin } from "../commands/grep-routing.js";
import { loonfsGrepCommand } from "../commands/loonfs-grep.js";
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
  const limits = resolveWorkspaceLimits(options.limits);
  const mountPoint = normalizeVirtualPath(options.mountPoint ?? "/workspace", "mount");
  const backend = resolveBackend(options);
  const namespace = await backend.getNamespace();
  const capabilities = await backend.getCapabilities();
  const context = new MutationContext({
    actor: options.actor,
    maxMutationsPerExec: limits.maxMutationsPerExec,
    maxLoonFsRequestsPerExec: limits.maxLoonFsRequestsPerExec,
  });
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
  const fs = new MountableFs({
    base: new InMemoryFs(),
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
    ];
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  });
  const serverGrep = capabilities.serverGrep && backend.grepNamespace !== undefined;
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
      maxExecutionTimeMs: 30_000,
      maxOutputSize: 2 * 1024 * 1024,
      maxInputBytes: 32 * 1024 * 1024,
      maxLiveBytes: 64 * 1024 * 1024,
      maxFileSystemBytes: 128 * 1024 * 1024,
      maxTraversalEntries: 50_000,
      maxTraversalDepth: 128,
      maxTraversalWork: 100_000,
      maxGlobOperations: 50_000,
      maxCommandCount: 1_000,
      maxLoopIterations: 10_000,
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
  });
}

interface WorkspaceIdentity {
  namespaceId: string;
  mountPoint: string;
  access: WorkspaceAccess;
  limits: WorkspaceLimits;
}

class WorkspaceShell implements LoonFsWorkspaceShell {
  private readonly bash: Bash;
  private readonly backend: LoonFsBackend;
  private readonly context: MutationContext;
  private readonly routing: BashTransformPipeline<{ loonfsGrepRouting?: { routed: number; local: number } }>;
  private readonly identity: WorkspaceIdentity;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    bash: Bash,
    backend: LoonFsBackend,
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
    if (this.closed) {
      throw new Error("this workspace shell is closed");
    }
    this.context.beginExecution(options?.message);
    const headSeqBefore = (await this.backend.getNamespace()).headSeq;
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
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
      stderr = `${error instanceof Error ? error.message : String(error)}\n`;
      exitCode = 1;
    }
    const headSeqAfter = (await this.backend.getNamespace()).headSeq;
    const counters = this.context.snapshot();
    const searchModes = this.context.searchModes();
    return {
      stdout,
      stderr,
      exitCode,
      headSeqBefore,
      headSeqAfter,
      mutations: counters.mutations,
      bytesRead: counters.bytesRead,
      bytesWritten: counters.bytesWritten,
      ...(searchModes.length > 0 ? { searchModes } : {}),
    };
  }

  async refresh(): Promise<void> {
    await this.backend.getNamespace();
  }

  async info(): Promise<WorkspaceInfo> {
    return {
      namespaceId: this.identity.namespaceId,
      mountPoint: this.identity.mountPoint,
      access: this.identity.access,
      headSeq: (await this.backend.getNamespace()).headSeq,
      limits: this.identity.limits,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
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
