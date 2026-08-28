import { describe, expect, it } from "vitest";
import {
  FakeLoonFsBackend,
  LoonFsBackendError,
  LoonFsFileSystem,
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
    expect(result.mutations).toBe(2);
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
    expect(summary.mutations).toBe(2);
    expect(summary.bytesWritten).toBe(4);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.headSeqAfter).toBeGreaterThan(summary.headSeqBefore ?? 0);
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
});
