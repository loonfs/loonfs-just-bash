import { describe, expect, it } from "vitest";
import { FakeLoonFsBackend, LoonFsFileSystem, MutationContext } from "../../src/index.js";
import type { LoonFsBackend, WorkspaceFsError } from "../../src/index.js";

function seeded(options?: {
  maxReadBytes?: number;
  maxDirectoryEntries?: number;
  directoryPageSize?: number;
}): LoonFsFileSystem {
  const backend = new FakeLoonFsBackend({ namespaceId: "ns_test" });
  backend.seedFile("/contracts/acme.txt", "termination clause\n");
  backend.seedFile("/contracts/zenith.txt", "renewal clause\n");
  backend.seedFile("/contracts/.hidden", "dot");
  backend.seedFile("/data/unicode-é.txt", "café");
  backend.seedFile("/data/binary.bin", new Uint8Array([0, 255, 128, 10]));
  backend.seedFile("/data/empty.txt", "");
  return new LoonFsFileSystem({ backend, ...options });
}

async function failure(run: Promise<unknown>): Promise<WorkspaceFsError> {
  try {
    await run;
  } catch (error) {
    return error as WorkspaceFsError;
  }
  throw new Error("expected a failure");
}

describe("LoonFsFileSystem read side", () => {
  it("maps entries to just-bash stats with synthetic modes", async () => {
    const fs = seeded();
    const file = await fs.stat("/contracts/acme.txt");
    expect(file.isFile).toBe(true);
    expect(file.mode).toBe(0o644);
    expect(file.size).toBe("termination clause\n".length);
    expect(file.identity).toMatch(/^ns_test:ino_\d+$/);
    expect(typeof file.ino).toBe("bigint");
    const directory = await fs.stat("/contracts");
    expect(directory.isDirectory).toBe(true);
    expect(directory.mode).toBe(0o755);
    expect(directory.size).toBe(0);
    expect(await fs.lstat("/contracts").then((s) => s.isSymbolicLink)).toBe(false);
  });

  it("speaks the just-bash error message convention", async () => {
    const fs = seeded();
    const missing = await failure(fs.stat("/missing.txt"));
    expect(missing.message).toBe("ENOENT: no such file or directory, stat '/missing.txt'");
    expect(missing.code).toBe("ENOENT");
    expect(missing.loonfsCode).toBe("not_found");
    expect((await failure(fs.readFile("/contracts"))).code).toBe("EISDIR");
    expect((await failure(fs.readdir("/contracts/acme.txt"))).code).toBe("ENOTDIR");
  });

  it("answers exists only from true absence", async () => {
    const fs = seeded();
    expect(await fs.exists("/contracts/acme.txt")).toBe(true);
    expect(await fs.exists("/missing")).toBe(false);
  });

  it("lists names through pagination and refuses oversized directories", async () => {
    const fs = seeded({ directoryPageSize: 2 });
    expect(await fs.readdir("/contracts")).toEqual([".hidden", "acme.txt", "zenith.txt"]);
    const typed = await fs.readdirWithFileTypes("/data");
    expect(typed.every((entry) => entry.isFile)).toBe(true);
    const bounded = seeded({ maxDirectoryEntries: 2 });
    expect((await failure(bounded.readdir("/contracts"))).code).toBe("E2BIG");
  });

  it("rejects a backend cursor that cannot advance", async () => {
    const backend = new FakeLoonFsBackend();
    const stalled = new Proxy(backend, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "listDirectoryPage") {
          return async () => ({ entries: [], nextCursor: "stalled", headSeq: 0 });
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as LoonFsBackend;
    const fs = new LoonFsFileSystem({ backend: stalled });
    const error = await failure(fs.readdir("/"));
    expect(error.code).toBe("EIO");
    expect(error.message).toContain("non-advancing directory cursor");
  });

  it("reads text, bytes, and buffers faithfully", async () => {
    const fs = seeded();
    expect(await fs.readFile("/data/unicode-é.txt")).toBe("café");
    expect(await fs.readFile("/data/empty.txt")).toBe("");
    expect([...(await fs.readFileBuffer("/data/binary.bin"))]).toEqual([0, 255, 128, 10]);
    const byteString = await fs.readFileBytes("/data/binary.bin");
    expect(byteString.length).toBe(4);
    expect(await fs.readFile("/data/binary.bin", "base64")).toBe(
      Buffer.from([0, 255, 128, 10]).toString("base64"),
    );
  });

  it("enforces the read byte limit from the stat", async () => {
    const fs = seeded({ maxReadBytes: 4 });
    const oversized = await failure(fs.readFile("/contracts/acme.txt"));
    expect(oversized.code).toBe("EFBIG");
    expect(oversized.message).toContain("read limit");
  });

  it("enforces request budgets when the exported adapter is used directly", async () => {
    const backend = new FakeLoonFsBackend();
    backend.seedFile("/one.txt", "one");
    const context = new MutationContext({
      actor: { kind: "service", id: "agent_test" },
      maxLoonFsRequestsPerExec: 1,
    });
    context.beginExecution();
    const fs = new LoonFsFileSystem({ backend, context });
    await expect(fs.stat("/one.txt")).resolves.toBeDefined();
    await expect(fs.stat("/one.txt")).rejects.toThrow(/1-request budget/);
    expect(context.snapshot().requests).toBe(2);
  });

  it("resolves and verifies realpath without link traversal", async () => {
    const fs = seeded();
    expect(fs.resolvePath("/contracts", "../data/empty.txt")).toBe("/data/empty.txt");
    expect(await fs.realpath("/contracts/../data/empty.txt")).toBe("/data/empty.txt");
    expect((await failure(fs.realpath("/nope"))).code).toBe("ENOENT");
  });

  it("refuses writes and unsupported semantics without faking success", async () => {
    const fs = seeded();
    expect((await failure(fs.writeFile("/x", "y"))).code).toBe("EROFS");
    expect((await failure(fs.mkdir("/d"))).code).toBe("EROFS");
    expect((await failure(fs.rm("/contracts/acme.txt"))).code).toBe("EROFS");
    expect((await failure(fs.chmod("/contracts/acme.txt", 0o755))).code).toBe("ENOTSUP");
    expect((await failure(fs.symlink("/a", "/b"))).code).toBe("ENOTSUP");
    expect((await failure(fs.link("/a", "/b"))).code).toBe("ENOTSUP");
    expect((await failure(fs.readlink("/a"))).code).toBe("ENOTSUP");
    expect((await failure(fs.utimes("/contracts/acme.txt", new Date(), new Date()))).code).toBe(
      "ENOTSUP",
    );
    expect(() => fs.getAllPaths()).toThrow(/ENOTSUP/);
  });
});
