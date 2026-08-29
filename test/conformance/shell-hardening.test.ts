import { describe, expect, it } from "vitest";
import {
  FakeLoonFsBackend,
  LoonFsBackendError,
  LoonFsFileSystem,
  MutationContext,
  createLoonFsWorkspaceShell,
} from "../../src/index.js";
import type { LoonFsBackend, WorkspaceExecutionSummary } from "../../src/index.js";

const actor = { kind: "service", id: "agent_42" } as const;

describe("execution result hardening", () => {
  it("completes an execution even when head telemetry fails", async () => {
    const backend = new FakeLoonFsBackend();
    let namespaceCalls = 0;
    const flaky = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "getNamespace" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          namespaceCalls += 1;
          // The shell reads the head once at creation, then before and after
          // each execution; fail everything after the pre-exec read.
          if (namespaceCalls > 2) {
            throw new Error("telemetry outage");
          }
          return (value as () => Promise<unknown>).call(target);
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await createLoonFsWorkspaceShell({ backend: flaky, actor, access: "read-write" });
    const result = await ws.exec("echo committed > kept.txt && cat kept.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("committed\n");
    expect(result.mutations).toBe(1);
    expect(result.headSeqAfter).toBeUndefined();
    expect(
      new TextDecoder().decode((await backend.readFile("/kept.txt")).bytes),
    ).toBe("committed\n");
  });

  it("close waits for the in-flight execution to finish", async () => {
    const backend = new FakeLoonFsBackend();
    let releaseWrite: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const slow = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "writeFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          await gate;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await createLoonFsWorkspaceShell({ backend: slow, actor, access: "read-write" });
    const running = ws.exec("echo slow > slow.txt");
    const closing = ws.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    releaseWrite!();
    await closing;
    expect((await running).exitCode).toBe(0);
    await expect(ws.exec("pwd")).rejects.toThrow(/closed/);
  });

  it("refuses bytes past the read limit even when the stat raced", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/small.txt", "ok");
    const lying = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "readFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const read = await (value as (p: string) => Promise<{ bytes: Uint8Array; entry: unknown }>).call(target, "/small.txt");
          return { ...read, bytes: new Uint8Array(64) };
        };
      },
    }) as unknown as LoonFsBackend;
    const fs = new LoonFsFileSystem({ backend: lying, maxReadBytes: 16 });
    await expect(fs.readFile("/small.txt")).rejects.toThrow(/EFBIG.*read returned 64 bytes/);
  });

  it("refuses an append source that grows after stat", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/small.txt", "ok");
    const racing = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "readFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const read = await (
            value as (p: string) => Promise<{ bytes: Uint8Array; entry: unknown }>
          ).call(target, "/small.txt");
          return { ...read, bytes: new Uint8Array(64) };
        };
      },
    }) as unknown as LoonFsBackend;
    const context = new MutationContext({ actor });
    const fs = new LoonFsFileSystem({
      backend: racing,
      access: "read-write",
      context,
      maxAppendSourceBytes: 16,
    });
    await expect(fs.appendFile("/small.txt", "x")).rejects.toThrow(
      /EFBIG.*append read 64 bytes/,
    );
    expect(context.snapshot().bytesRead).toBe(64);
  });

  it("emits one structured summary per execution", async () => {
    const backend = new FakeLoonFsBackend({ namespaceId: "ns_obs" });
    const summaries: WorkspaceExecutionSummary[] = [];
    const ws = await createLoonFsWorkspaceShell({
      backend,
      actor,
      access: "read-write",
      onExecutionSummary: (summary) => summaries.push(summary),
    });
    await ws.exec("echo one > a.txt", { toolCallId: "call_9", message: "record a" });
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.namespaceId).toBe("ns_obs");
    expect(summary.toolCallId).toBe("call_9");
    expect(summary.message).toBe("record a");
    expect(summary.exitCode).toBe(0);
    expect(summary.requests).toBeGreaterThan(0);
    expect(summary.mutations).toBe(1);
    expect(summary.bytesWritten).toBe(4);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.headSeqAfter).toBeGreaterThan(summary.headSeqBefore ?? 0);
  });

  it("contains rejected asynchronous summary observers", async () => {
    const backend = new FakeLoonFsBackend();
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      const ws = await createLoonFsWorkspaceShell({
        backend,
        actor,
        onExecutionSummary: async () => {
          throw new Error("observer rejected");
        },
      });
      const result = await ws.exec("pwd");
      expect(result.exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("keeps a timed-out read from charging the next execution", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/one.txt", "one");
    backend.seedFile("/two.txt", "two-two");
    let releaseOne: (() => void) | undefined;
    let releaseTwo: (() => void) | undefined;
    let markTwoStarted: (() => void) | undefined;
    const oneGate = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });
    const twoGate = new Promise<void>((resolve) => {
      releaseTwo = resolve;
    });
    const twoStarted = new Promise<void>((resolve) => {
      markTwoStarted = resolve;
    });
    const delayed = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "readFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (path: string) => {
          if (path === "/one.txt") {
            await oneGate;
          } else if (path === "/two.txt") {
            markTwoStarted!();
            await twoGate;
          }
          return (value as (p: string) => Promise<unknown>).call(target, path);
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await createLoonFsWorkspaceShell({
      backend: delayed,
      actor,
      limits: { maxExecutionTimeMs: 25 },
    });
    const timedOut = await ws.exec("cat one.txt");
    expect(timedOut.exitCode).toBe(124);
    const nextExecution = ws.exec("cat two.txt");
    await twoStarted;
    releaseOne!();
    await new Promise((resolve) => setImmediate(resolve));
    releaseTwo!();
    const next = await nextExecution;
    expect(next.exitCode).toBe(0);
    expect(next.bytesRead).toBe("two-two".length);
  });

  it("does not let a summary observer mutate the execution result", async () => {
    const backend = new FakeLoonFsBackend();
    const ws = await createLoonFsWorkspaceShell({
      backend,
      actor,
      onExecutionSummary: (summary) => {
        summary.searchModes.push("rejected");
      },
    });
    const result = await ws.exec("pwd");
    expect(result.searchModes).toBeUndefined();
  });

  it("latches a fenced writer until refresh clears it", async () => {
    const backend = new FakeLoonFsBackend();
    let fenceNext = true;
    let backendWrites = 0;
    const fencing = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "writeFile" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          backendWrites += 1;
          if (fenceNext) {
            fenceNext = false;
            throw new LoonFsBackendError("writer_fenced", "the writer was fenced");
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await createLoonFsWorkspaceShell({ backend: fencing, actor, access: "read-write" });
    const fenced = await ws.exec("echo x > fenced.txt");
    expect(fenced.exitCode).not.toBe(0);
    const writesAfterFence = backendWrites;
    const latched = await ws.exec("echo y > latched.txt && mkdir latched-dir");
    expect(latched.exitCode).not.toBe(0);
    expect(latched.stderr).toContain("must not continue writing");
    expect(backendWrites).toBe(writesAfterFence);
    expect((await ws.exec("cat /workspace 2>/dev/null; ls")).exitCode).toBe(0);
    await ws.refresh();
    const recovered = await ws.exec("echo z > recovered.txt && cat recovered.txt");
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stdout).toBe("z\n");
  });

  it("keeps the writer fence latched when refresh cannot reach the deployment", async () => {
    const backend = new FakeLoonFsBackend();
    let fenceNext = true;
    let failNamespace = false;
    let backendWrites = 0;
    const unreliable = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "getNamespace") {
          return async () => {
            if (failNamespace) {
              throw new Error("offline");
            }
            return (value as () => Promise<unknown>).call(target);
          };
        }
        if (property === "writeFile") {
          return async (...args: unknown[]) => {
            backendWrites += 1;
            if (fenceNext) {
              fenceNext = false;
              throw new LoonFsBackendError("writer_fenced", "fenced");
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as LoonFsBackend;
    const ws = await createLoonFsWorkspaceShell({
      backend: unreliable,
      actor,
      access: "read-write",
    });
    expect((await ws.exec("echo x > fenced.txt")).exitCode).not.toBe(0);
    failNamespace = true;
    await expect(ws.refresh()).rejects.toThrow("offline");
    failNamespace = false;
    const callsAfterFence = backendWrites;
    expect((await ws.exec("echo y > still-fenced.txt")).exitCode).not.toBe(0);
    expect(backendWrites).toBe(callsAfterFence);
  });
});
