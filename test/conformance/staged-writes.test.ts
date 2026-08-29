import { describe, expect, it } from "vitest";
import {
  FakeLoonFsBackend,
  LoonFsBackendError,
  createLoonFsWorkspaceShell,
} from "../../src/index.js";
import type {
  LoonFsBackend,
  LoonFsWorkspaceShell,
  WorkspaceLimits,
} from "../../src/index.js";

const actor = { kind: "service", id: "agent_staged" } as const;

function shell(
  backend: LoonFsBackend,
  limits?: Partial<WorkspaceLimits>,
): Promise<LoonFsWorkspaceShell> {
  return createLoonFsWorkspaceShell({
    backend,
    actor,
    access: "read-write",
    ...(limits !== undefined ? { limits } : {}),
  });
}

async function read(backend: LoonFsBackend, path: string): Promise<string> {
  const fresh = await shell(backend);
  const result = await fresh.exec(`cat ${path}`);
  await fresh.close();
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("staged workspace writes", () => {
  it("a rejected oversized redirect leaves the current revision and head alone", async () => {
    const backend = new FakeLoonFsBackend();
    const seed = await shell(backend);
    await seed.exec("printf ORIGINAL-CONTENT > /workspace/important.txt");
    const before = (await backend.getNamespace()).headSeq;
    const bounded = await shell(backend, { maxWriteBytes: 8 });
    const failure = await bounded.exec("printf 0123456789 > /workspace/important.txt");
    expect(failure.exitCode).not.toBe(0);
    expect(failure.stderr).toContain("EFBIG");
    expect(await read(backend, "/workspace/important.txt")).toBe("ORIGINAL-CONTENT");
    expect((await backend.getNamespace()).headSeq).toBe(before);
    expect(failure.mutations).toBe(0);
  });

  it("an aborted producer leaves the target untouched", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend, { maxLoopIterations: 16 });
    await ws.exec("printf ORIGINAL > /workspace/f.txt");
    const before = (await backend.getNamespace()).headSeq;
    const result = await ws.exec("seq 1 400 > /workspace/f.txt");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain(
      "loonfs: the staged write to '/workspace/f.txt' was discarded because the execution was interrupted",
    );
    expect(await read(backend, "/workspace/f.txt")).toBe("ORIGINAL");
    expect((await backend.getNamespace()).headSeq).toBe(before);
    expect(result.mutations).toBe(0);
  });

  it("a rejected write to a new path creates nothing", async () => {
    const backend = new FakeLoonFsBackend();
    const bounded = await shell(backend, { maxWriteBytes: 8 });
    const before = (await backend.getNamespace()).headSeq;
    const result = await bounded.exec("printf 0123456789 > /workspace/new.txt");
    expect(result.exitCode).not.toBe(0);
    const fresh = await shell(backend);
    expect((await fresh.exec("ls /workspace")).stdout).not.toContain("new.txt");
    expect((await backend.getNamespace()).headSeq).toBe(before);
  });

  it("a successful redirect is one commit", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    const result = await ws.exec("echo hi > /workspace/one.txt");
    expect(result.mutations).toBe(1);
    expect(result.headSeqAfter).toBe((result.headSeqBefore ?? 0) + 1);
  });

  it("an append to an existing file is one commit", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    await ws.exec("printf seed > /workspace/one.txt");
    const result = await ws.exec("echo x >> /workspace/one.txt");
    expect(result.mutations).toBe(1);
    expect(await read(backend, "/workspace/one.txt")).toBe("seedx\n");
  });

  it("empty results still land durably", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    await ws.exec("printf 'one\\ntwo\\n' > /workspace/f.txt");
    const emptied = await ws.exec("sed -i 'd' /workspace/f.txt");
    expect(emptied.exitCode).toBe(0);
    expect(emptied.mutations).toBe(1);
    expect(await read(backend, "/workspace/f.txt")).toBe("");
    await ws.exec("printf reseeded > /workspace/f.txt");
    const failed = await ws.exec("false > /workspace/f.txt");
    expect(failed.exitCode).toBe(1);
    expect(await read(backend, "/workspace/f.txt")).toBe("");
  });

  it("a staged create is visible inside its own execution", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    const result = await ws.exec(
      ": > /workspace/flag.txt && test -f /workspace/flag.txt && cat /workspace/flag.txt",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await read(backend, "/workspace/flag.txt")).toBe("");
  });

  it("cat into its own source truncates once", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    await ws.exec("printf data > /workspace/f.txt");
    const result = await ws.exec("cat /workspace/f.txt > /workspace/f.txt");
    expect(result.exitCode).toBe(0);
    expect(result.mutations).toBe(1);
    expect(await read(backend, "/workspace/f.txt")).toBe("");
  });

  it("rm wins over a staged truncate", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    await ws.exec("printf data > /workspace/f.txt");
    const result = await ws.exec(": > /workspace/f.txt && rm /workspace/f.txt");
    expect(result.exitCode).toBe(0);
    const fresh = await shell(backend);
    const listing = await fresh.exec("ls /workspace");
    expect(listing.stdout).not.toContain("f.txt");
  });

  it("a failing deferred write surfaces and fails the execution", async () => {
    const backend = new FakeLoonFsBackend();
    const refusing = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "writeFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          if (args[1] instanceof Uint8Array && args[1].byteLength === 0) {
            throw new LoonFsBackendError("busy", "injected settle failure");
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await shell(refusing);
    const result = await ws.exec("false > /workspace/f.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("loonfs: the staged write to '/workspace/f.txt' failed:");
  });

  it("a refused read explains the limit on stderr", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/docs/data.json", "1234567890123456789012345678901");
    const ws = await shell(backend, { maxReadBytes: 4 });
    const result = await ws.exec("cat /workspace/docs/data.json");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("loonfs: EFBIG");
    expect(result.stderr).toContain("read limit is 4");
  });

  it("construction refuses a server that cannot answer path reads", async () => {
    const backend = new FakeLoonFsBackend();
    const outdated = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "stat" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (path: string) => {
          if (path === "/") {
            throw new LoonFsBackendError("unsupported", "no v0 route matches");
          }
          return (value as (entryPath: string) => Promise<unknown>).call(target, path);
        };
      },
    }) as unknown as LoonFsBackend;
    await expect(shell(outdated)).rejects.toThrow(/v0\.3/);
  });

  it("a shell function named grep is left alone", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    const result = await ws.exec("grep() { echo shadowed; }\ngrep -r pattern /workspace");
    expect(result.stdout).toBe("shadowed\n");
    expect(result.searchModes).toBeUndefined();
  });
});
