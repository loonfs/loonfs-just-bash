import { describe, expect, it } from "vitest";
import { FakeLoonFsBackend, LoonFsBackendError } from "../../src/index.js";
import type { MutationCommit } from "../../src/index.js";

function commit(n: number): MutationCommit {
  return { commitId: `c_${n}`, actor: { kind: "service", id: "test" } };
}

function seeded(): FakeLoonFsBackend {
  const backend = new FakeLoonFsBackend({ namespaceId: "ns_test" });
  backend.seedFile("/contracts/acme.txt", "termination clause");
  backend.seedFile("/contracts/zenith.txt", "renewal clause");
  backend.seedFile("/readme.md", "hello");
  return backend;
}

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return "ok";
  } catch (error) {
    if (error instanceof LoonFsBackendError) {
      return error.code;
    }
    throw error;
  }
}

describe("FakeLoonFsBackend", () => {
  it("stats files and directories with LoonFS-shaped entries", async () => {
    const backend = seeded();
    const file = await backend.stat("/contracts/acme.txt");
    expect(file.kind).toBe("file");
    expect(file.inodeId).toMatch(/^ino_\d+$/);
    expect(file.file?.revisionNo).toBe(1);
    expect(file.file?.sizeBytes).toBe("termination clause".length);
    const directory = await backend.stat("/contracts");
    expect(directory.kind).toBe("directory");
    expect(directory.file).toBeUndefined();
    expect(await code(backend.stat("/missing"))).toBe("not_found");
  });

  it("lists directories in name order across pages", async () => {
    const backend = seeded();
    backend.seedFile("/contracts/baker.txt", "x");
    const first = await backend.listDirectoryPage("/contracts", { limit: 2 });
    expect(first.entries.map((entry) => entry.name)).toEqual(["acme.txt", "baker.txt"]);
    expect(first.nextCursor).toBe("baker.txt");
    const second = await backend.listDirectoryPage("/contracts", {
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.entries.map((entry) => entry.name)).toEqual(["zenith.txt"]);
    expect(second.nextCursor).toBeUndefined();
    expect(await code(backend.listDirectoryPage("/readme.md", { limit: 1 }))).toBe(
      "not_a_directory",
    );
  });

  it("round-trips file bytes", async () => {
    const backend = seeded();
    const read = await backend.readFile("/contracts/acme.txt");
    expect(new TextDecoder().decode(read.bytes)).toBe("termination clause");
    expect(read.entry.file?.revisionNo).toBe(1);
    expect(await code(backend.readFile("/contracts"))).toBe("is_a_directory");
  });

  it("guards writes with behavior and expected revision", async () => {
    const backend = seeded();
    const bytes = new TextEncoder().encode("v2");
    expect(
      await code(
        backend.writeFile("/readme.md", bytes, { behavior: "no-replace", commit: commit(1) }),
      ),
    ).toBe("destination_exists");
    expect(
      await code(
        backend.writeFile("/readme.md", bytes, {
          behavior: "replace",
          expectedRevisionNo: 99,
          commit: commit(2),
        }),
      ),
    ).toBe("stale_revision");
    const receipt = await backend.writeFile("/readme.md", bytes, {
      behavior: "replace",
      expectedRevisionNo: 1,
      commit: commit(3),
    });
    expect(receipt.entry?.file?.revisionNo).toBe(2);
  });

  it("replays an applied commit id without re-checking guards", async () => {
    const backend = seeded();
    const bytes = new TextEncoder().encode("written once");
    const first = await backend.writeFile("/new.txt", bytes, {
      behavior: "no-replace",
      commit: commit(1),
    });
    const replay = await backend.writeFile("/new.txt", bytes, {
      behavior: "no-replace",
      commit: commit(1),
    });
    expect(replay).toEqual(first);
    expect((await backend.getNamespace()).headSeq).toBe(first.headSeq);
  });

  it("rejects a commit id reused for a different mutation", async () => {
    const backend = seeded();
    const bytes = new TextEncoder().encode("first payload");
    await backend.writeFile("/new.txt", bytes, {
      behavior: "no-replace",
      commit: commit(1),
    });
    const reused = await code(
      backend.writeFile("/other.txt", new TextEncoder().encode("other payload"), {
        behavior: "no-replace",
        commit: commit(1),
      }),
    );
    expect(reused).toBe("internal");
    expect(await code(backend.stat("/other.txt"))).toBe("not_found");
  });

  it("guards deletes with emptiness and the observed inode", async () => {
    const backend = seeded();
    expect(
      await code(backend.deletePath("/contracts", { recursive: false, commit: commit(1) })),
    ).toBe("directory_not_empty");
    expect(
      await code(
        backend.deletePath("/readme.md", {
          recursive: false,
          expectedInodeId: "ino_9999",
          commit: commit(2),
        }),
      ),
    ).toBe("raced_binding");
    await backend.deletePath("/contracts", { recursive: true, commit: commit(3) });
    expect(await code(backend.stat("/contracts/acme.txt"))).toBe("not_found");
  });

  it("moves preserve identity and copies reuse the displaced destination", async () => {
    const backend = seeded();
    const before = await backend.stat("/contracts/acme.txt");
    await backend.movePath("/contracts/acme.txt", "/final.txt", {
      behavior: "no-replace",
      commit: commit(1),
    });
    const moved = await backend.stat("/final.txt");
    expect(moved.inodeId).toBe(before.inodeId);
    expect(
      await code(
        backend.movePath("/final.txt", "/readme.md", { behavior: "no-replace", commit: commit(2) }),
      ),
    ).toBe("destination_exists");
    const target = await backend.stat("/readme.md");
    const copied = await backend.copyFile("/final.txt", "/readme.md", {
      behavior: "replace",
      commit: commit(3),
    });
    expect(copied.entry?.inodeId).toBe(target.inodeId);
    expect(copied.entry?.file?.revisionNo).toBe((target.file?.revisionNo ?? 0) + 1);
    expect(new TextDecoder().decode((await backend.readFile("/readme.md")).bytes)).toBe(
      "termination clause",
    );
  });

  it("is deterministic across instances", async () => {
    const run = async () => {
      const backend = seeded();
      await backend.createDirectory("/output", { parents: false, commit: commit(1) });
      const write = await backend.writeFile("/output/result.json", new Uint8Array([1, 2]), {
        behavior: "no-replace",
        commit: commit(2),
      });
      return { write, namespace: await backend.getNamespace() };
    };
    expect(await run()).toEqual(await run());
  });
});
