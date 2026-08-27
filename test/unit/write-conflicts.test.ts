import { describe, expect, it } from "vitest";
import {
  FakeLoonFsBackend,
  LoonFsFileSystem,
  MutationContext,
} from "../../src/index.js";
import type { LoonFsBackend, MutationCommit, WorkspaceFsError } from "../../src/index.js";

/** Delegates to the fake, running a scheduled external mutation just before
 * one intercepted call, so races land exactly between observe and publish. */
function intercepting(fake: FakeLoonFsBackend): {
  backend: LoonFsBackend;
  beforeNext: (method: string, run: () => Promise<void>) => void;
} {
  let pending: { method: string; run: () => Promise<void> } | undefined;
  const backend = new Proxy(fake, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return async (...args: unknown[]) => {
        if (pending?.method === property) {
          const run = pending.run;
          pending = undefined;
          await run();
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as LoonFsBackend;
  return { backend, beforeNext: (method, run) => (pending = { method, run }) };
}

let externalCounter = 0;
function externalCommit(): MutationCommit {
  externalCounter += 1;
  return { commitId: `external_${externalCounter}`, actor: { kind: "user", id: "other-writer" } };
}

function workspace(backend: LoonFsBackend, overrides?: { access?: "read-only" | "read-write"; maxMutationsPerExec?: number; maxWriteBytes?: number; maxAppendSourceBytes?: number }) {
  const context = new MutationContext({
    actor: { kind: "service", id: "agent_test" },
    ...(overrides?.maxMutationsPerExec !== undefined
      ? { maxMutationsPerExec: overrides.maxMutationsPerExec }
      : {}),
  });
  const fs = new LoonFsFileSystem({
    backend,
    access: overrides?.access ?? "read-write",
    context,
    ...(overrides?.maxWriteBytes !== undefined ? { maxWriteBytes: overrides.maxWriteBytes } : {}),
    ...(overrides?.maxAppendSourceBytes !== undefined
      ? { maxAppendSourceBytes: overrides.maxAppendSourceBytes }
      : {}),
  });
  return { fs, context };
}

async function failure(run: Promise<unknown>): Promise<WorkspaceFsError> {
  try {
    await run;
  } catch (error) {
    return error as WorkspaceFsError;
  }
  throw new Error("expected a failure");
}

describe("guarded mutations under concurrency", () => {
  it("a replacement raced by an external writer conflicts instead of overwriting", async () => {
    const fake = new FakeLoonFsBackend();
    fake.seedFile("/report.md", "first draft");
    const { backend, beforeNext } = intercepting(fake);
    const { fs } = workspace(backend);
    beforeNext("writeFile", async () => {
      await fake.writeFile("/report.md", new TextEncoder().encode("external edit"), {
        behavior: "replace",
        expectedRevisionNo: 1,
        commit: externalCommit(),
      });
    });
    const conflict = await failure(fs.writeFile("/report.md", "agent edit"));
    expect(conflict.code).toBe("ESTALE");
    expect(conflict.loonfsCode).toBe("stale_revision");
    expect(new TextDecoder().decode((await fake.readFile("/report.md")).bytes)).toBe(
      "external edit",
    );
  });

  it("a create raced by an external create conflicts instead of replacing", async () => {
    const fake = new FakeLoonFsBackend();
    const { backend, beforeNext } = intercepting(fake);
    const { fs } = workspace(backend);
    beforeNext("writeFile", async () => {
      fake.seedFile("/result.json", "external result");
    });
    const conflict = await failure(fs.writeFile("/result.json", "agent result"));
    expect(conflict.code).toBe("EEXIST");
    expect(new TextDecoder().decode((await fake.readFile("/result.json")).bytes)).toBe(
      "external result",
    );
  });

  it("a delete raced by a rebinding conflicts and the successor survives", async () => {
    const fake = new FakeLoonFsBackend();
    fake.seedFile("/draft.md", "original");
    const { backend, beforeNext } = intercepting(fake);
    const { fs } = workspace(backend);
    beforeNext("deletePath", async () => {
      await fake.deletePath("/draft.md", { recursive: false, commit: externalCommit() });
      await fake.writeFile("/draft.md", new TextEncoder().encode("successor"), {
        behavior: "no-replace",
        commit: externalCommit(),
      });
    });
    const conflict = await failure(fs.rm("/draft.md"));
    expect(conflict.code).toBe("ESTALE");
    expect(conflict.loonfsCode).toBe("raced_binding");
    expect(new TextDecoder().decode((await fake.readFile("/draft.md")).bytes)).toBe("successor");
  });

  it("append is a bounded guarded rewrite", async () => {
    const fake = new FakeLoonFsBackend();
    const { fs } = workspace(fake, { maxAppendSourceBytes: 7 });
    await fs.appendFile("/log.txt", "one\n");
    await fs.appendFile("/log.txt", "two\n");
    expect(new TextDecoder().decode((await fake.readFile("/log.txt")).bytes)).toBe("one\ntwo\n");
    expect((await fake.stat("/log.txt")).file?.revisionNo).toBe(2);
    const oversized = await failure(fs.appendFile("/log.txt", "three\n"));
    expect(oversized.code).toBe("EFBIG");
    expect(oversized.message).toContain("use /tmp for scratch append");
  });

  it("enforces write bytes and the mutation budget", async () => {
    const fake = new FakeLoonFsBackend();
    const bounded = workspace(fake, { maxWriteBytes: 4 });
    expect((await failure(bounded.fs.writeFile("/big.bin", "12345"))).code).toBe("EFBIG");
    const budgeted = workspace(fake, { maxMutationsPerExec: 1 });
    await budgeted.fs.mkdir("/a");
    expect((await failure(budgeted.fs.mkdir("/b"))).code).toBe("E2BIG");
    expect(budgeted.context.snapshot().mutations).toBe(2);
  });

  it("keeps a read-only attachment read-only", async () => {
    const fake = new FakeLoonFsBackend();
    fake.seedFile("/doc.md", "x");
    const fs = new LoonFsFileSystem({ backend: fake });
    for (const attempt of [
      fs.writeFile("/doc.md", "y"),
      fs.appendFile("/doc.md", "y"),
      fs.mkdir("/d"),
      fs.rm("/doc.md"),
      fs.cp("/doc.md", "/copy.md"),
      fs.mv("/doc.md", "/moved.md"),
    ]) {
      expect((await failure(attempt)).code).toBe("EROFS");
    }
  });

  it("copies trees with native file copies and moves preserve identity", async () => {
    const fake = new FakeLoonFsBackend();
    fake.seedFile("/in/a.txt", "alpha");
    fake.seedFile("/in/nested/b.txt", "beta");
    const { fs, context } = workspace(fake);
    expect((await failure(fs.cp("/in", "/out"))).code).toBe("EISDIR");
    await fs.cp("/in", "/out", { recursive: true });
    expect(new TextDecoder().decode((await fake.readFile("/out/nested/b.txt")).bytes)).toBe("beta");
    const inode = (await fake.stat("/out/a.txt")).inodeId;
    await fs.mv("/out/a.txt", "/out/renamed.txt");
    expect((await fake.stat("/out/renamed.txt")).inodeId).toBe(inode);
    await fs.rm("/out", { recursive: true });
    expect(await fs.exists("/out")).toBe(false);
    expect(context.snapshot().requests).toBeGreaterThan(0);
    await fs.rm("/out", { force: true });
    expect((await failure(fs.rm("/out"))).code).toBe("ENOENT");
  });
});
