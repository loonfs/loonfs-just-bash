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
    expect(failed.stderr).toContain(
      "loonfs: the staged truncation of '/workspace/f.txt' was discarded because the script failed",
    );
    expect(await read(backend, "/workspace/f.txt")).toBe("reseeded");
  });

  it("a concurrent writer wins over a slow redirect", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/src.txt", "payload");
    backend.seedFile("/target.txt", "old");
    let wroteExternally = false;
    const concurrent = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "readFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (path: string) => {
          if (!wroteExternally) {
            wroteExternally = true;
            const observed = await target.stat("/target.txt");
            const expectedRevisionNo = observed.file?.revisionNo;
            if (expectedRevisionNo === undefined) {
              throw new Error("the redirect target has no file revision");
            }
            await target.writeFile("/target.txt", new TextEncoder().encode("external"), {
              behavior: "replace",
              expectedRevisionNo,
              commit: { commitId: "c_external1", actor },
            });
          }
          return (value as LoonFsBackend["readFile"]).call(target, path);
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await shell(concurrent);
    const result = await ws.exec("cat /workspace/src.txt > /workspace/target.txt");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ESTALE");
    expect(await read(backend, "/workspace/target.txt")).toBe("external");
  });

  it("an invalid redirect target fails before the producer runs", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/important.txt", "keep me");
    const ws = await shell(backend);
    const before = (await backend.getNamespace()).headSeq;
    const result = await ws.exec(
      ": > /workspace/missing-parent/child.txt && rm /workspace/important.txt",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no such file or directory");
    expect(await read(backend, "/workspace/important.txt")).toBe("keep me");
    expect((await backend.getNamespace()).headSeq).toBe(before);
  });

  it("command failures keep existing files", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/contract.txt", "signed");
    const ws = await shell(backend);
    const before = (await backend.getNamespace()).headSeq;
    const missingCommand = await ws.exec("python transform.py > /workspace/contract.txt");
    expect(missingCommand.exitCode).toBe(127);
    expect(missingCommand.stderr).toContain(
      "loonfs: the staged truncation of '/workspace/contract.txt' was discarded because the script failed",
    );
    expect(await read(backend, "/workspace/contract.txt")).toBe("signed");
    const missingInput = await ws.exec(
      "cat /workspace/missing.txt > /workspace/contract.txt",
    );
    expect(missingInput.exitCode).not.toBe(0);
    expect(missingInput.stderr).toContain(
      "loonfs: the staged truncation of '/workspace/contract.txt' was discarded because the script failed",
    );
    expect(await read(backend, "/workspace/contract.txt")).toBe("signed");
    expect((await backend.getNamespace()).headSeq).toBe(before);
  });

  it("a nonzero script still creates staged new files", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/seed.txt", "alpha");
    const ws = await shell(backend);
    const result = await ws.exec("grep zzz /workspace/seed.txt > /workspace/out.txt");
    expect(result.exitCode).toBe(1);
    expect(await read(backend, "/workspace/out.txt")).toBe("");
  });

  it("staged files appear in listings and survive structural commands", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    const listed = await ws.exec(": > /workspace/new.txt && ls /workspace");
    expect(listed.stdout).toContain("new.txt");

    const removed = await ws.exec(": > /workspace/a.txt && rm /workspace/a.txt");
    expect(removed.exitCode).toBe(0);
    expect((await ws.exec("test ! -e /workspace/a.txt")).exitCode).toBe(0);

    const moved = await ws.exec(
      ": > /workspace/b.txt && mv /workspace/b.txt /workspace/b2.txt",
    );
    expect(moved.exitCode).toBe(0);
    expect((await ws.exec("test -f /workspace/b2.txt && test ! -e /workspace/b.txt")).exitCode).toBe(
      0,
    );
    expect(await read(backend, "/workspace/b2.txt")).toBe("");

    const copied = await ws.exec(
      ": > /workspace/c.txt && cp /workspace/c.txt /workspace/c2.txt",
    );
    expect(copied.exitCode).toBe(0);
    expect(await read(backend, "/workspace/c.txt")).toBe("");
    expect(await read(backend, "/workspace/c2.txt")).toBe("");

    await ws.exec("printf data > /workspace/d.txt");
    const directoryConflict = await ws.exec(
      ": > /workspace/d.txt && mkdir /workspace/d.txt",
    );
    expect(directoryConflict.exitCode).not.toBe(0);
    expect((await ws.exec("test -f /workspace/d.txt")).exitCode).toBe(0);
    expect(await read(backend, "/workspace/d.txt")).toBe("");
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
    expect(result.stderr).not.toContain("No such file or directory");
    expect(result.stderr).toContain("cat: /workspace/docs/data.json: File too large");
    expect(result.stderr).toContain("loonfs: EFBIG");
    expect(result.stderr).toContain("read limit is 4");
  });

  it("a relative read failure is rewritten too", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/docs/data.json", "1234567890123456789012345678901");
    const ws = await shell(backend, { maxReadBytes: 4 });
    const result = await ws.exec("cat docs/data.json");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cat: docs/data.json: File too large");
    expect(result.stderr).not.toContain("No such file or directory");
  });

  it("a genuinely missing file keeps its message", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await shell(backend);
    const result = await ws.exec("cat /workspace/really-missing.txt");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "cat: /workspace/really-missing.txt: No such file or directory",
    );
  });

  it("an unreachable backend read says so", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/docs/data.json", "available later");
    const unreachable = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "readFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          throw new LoonFsBackendError(
            "busy",
            "the server asked this session to retry later",
          );
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await shell(unreachable);
    const result = await ws.exec("cat /workspace/docs/data.json");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Resource temporarily unavailable");
    expect(result.stderr).not.toContain("No such file or directory");
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
