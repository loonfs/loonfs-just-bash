import { describe, expect, it } from "vitest";
import { FakeLoonFsBackend, createLoonFsWorkspaceShell } from "../../src/index.js";
import type { LoonFsWorkspaceShell } from "../../src/index.js";

const actor = { kind: "service", id: "agent_42" } as const;

function seededBackend(): FakeLoonFsBackend {
  const backend = new FakeLoonFsBackend({ namespaceId: "ns_customer_123" });
  backend.seedFile("/contracts/acme.txt", "termination for convenience\n");
  backend.seedFile("/customers.json", '{"customers":[{"name":"Acme"}]}\n');
  return backend;
}

async function shell(
  backend: FakeLoonFsBackend,
  access: "read-only" | "read-write" = "read-write",
): Promise<LoonFsWorkspaceShell> {
  return createLoonFsWorkspaceShell({ backend, actor, access });
}

describe("LoonFsWorkspaceShell", () => {
  it("executes with observability fields and per-exec budgets", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    const write = await ws.exec('echo done > result.txt && cat result.txt', {
      toolCallId: "call_1",
      message: "record completion",
    });
    expect(write.exitCode).toBe(0);
    expect(write.stdout).toBe("done\n");
    expect(write.headSeqAfter).toBeGreaterThan(write.headSeqBefore ?? 0);
    expect(write.requests).toBeGreaterThan(0);
    expect(write.mutations).toBe(1);
    expect(write.bytesWritten).toBe(5);
    const read = await ws.exec("cat contracts/acme.txt");
    expect(read.mutations).toBe(0);
    expect(read.bytesRead).toBeGreaterThan(0);
    expect(read.headSeqAfter).toBe(read.headSeqBefore);
  });

  it("describes itself through info and workspace-info", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    const info = await ws.info();
    expect(info.namespaceId).toBe("ns_customer_123");
    expect(info.mountPoint).toBe("/workspace");
    info.limits.maxReadBytes = 1;
    expect((await ws.info()).limits.maxReadBytes).not.toBe(1);
    const command = await ws.exec("workspace-info");
    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain("namespace: ns_customer_123");
    expect(command.stdout).toContain("posix_compatible: false");
    expect(command.stdout).toContain("append: bounded whole-file replacement");
    expect(command.stdout).toContain("max_traversal_entries: 50000");
    expect(command.stdout).toContain("max_command_count: 1000");
    expect(command.stdout).toContain("max_loop_iterations: 10000");
    expect(command.stdout).toContain("max_loonfs_requests_per_exec: 2000");
    expect(command.stdout).toContain("max_execution_time_ms: 30000");
    expect(command.stdout).toContain("max_output_bytes: 2097152");
  });

  it("keeps the workspace durable and the scratch space ephemeral", async () => {
    const backend = seededBackend();
    const first = await shell(backend);
    expect((await first.exec("cd /tmp && pwd")).stdout).toBe("/tmp\n");
    await first.exec("echo durable > kept.txt && echo scratch > /tmp/lost.txt");
    expect((await first.exec("cat /tmp/lost.txt")).stdout).toBe("scratch\n");
    await first.close();
    const second = await shell(backend);
    expect((await second.exec("cat kept.txt")).stdout).toBe("durable\n");
    const lost = await second.exec("cat /tmp/lost.txt");
    expect(lost.exitCode).not.toBe(0);
  });

  it("makes HOME durable and refuses writes outside the workspace and /tmp", async () => {
    const backend = seededBackend();
    const first = await shell(backend);
    expect((await first.exec("printf '%s' \"$HOME\"")).stdout).toBe("/workspace");
    expect((await first.exec("echo home > ~/home.txt")).exitCode).toBe(0);
    expect((await first.exec("echo scratch > /tmp/scratch.txt")).exitCode).toBe(0);
    const outside = await first.exec("echo hidden > /outside.txt");
    expect(outside.exitCode).not.toBe(0);
    expect(outside.stderr).toContain("only /tmp and /workspace are writable");
    expect((await first.exec("printf discarded > /dev/null")).exitCode).toBe(0);
    await first.close();

    const second = await shell(backend);
    expect((await second.exec("cat ~/home.txt")).stdout).toBe("home\n");
    expect((await second.exec("test ! -e /tmp/scratch.txt")).exitCode).toBe(0);
    expect((await second.exec("test ! -e /outside.txt")).exitCode).toBe(0);
  });

  it("forwards just-bash exec options and returns the resulting environment", async () => {
    const ws = await shell(seededBackend());
    expect((await ws.exec("cat", { stdin: "from stdin" })).stdout).toBe("from stdin");

    const environment = await ws.exec("printf '%s' \"$CUSTOM_VALUE\"", {
      env: { CUSTOM_VALUE: "visible" },
    });
    expect(environment.stdout).toBe("visible");
    expect(environment.env?.CUSTOM_VALUE).toBe("visible");

    const replacedEnvironment = await ws.exec("printf '%s' \"$ONLY_VALUE\"", {
      env: { ONLY_VALUE: "replacement" },
      replaceEnv: true,
    });
    expect(replacedEnvironment.stdout).toBe("replacement");
    expect(replacedEnvironment.env?.ONLY_VALUE).toBe("replacement");
    expect(replacedEnvironment.env?.PATH).toBeUndefined();

    expect((await ws.exec("pwd", { cwd: "/tmp" })).stdout).toBe("/tmp\n");
    expect((await ws.exec("printf '%s|%s'", { args: ["first", "second"] })).stdout).toBe(
      "first|second",
    );
    expect(
      (
        await ws.exec("cat <<'EOF'\n  leading spaces\nEOF\n", {
          rawScript: true,
        })
      ).stdout,
    ).toBe("  leading spaces\n");
  });

  it("honors pre-aborted executions without publishing a staged write", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    const controller = new AbortController();
    controller.abort();
    const result = await ws.exec("echo never > aborted.txt", { signal: controller.signal });
    expect(result.exitCode).toBe(124);
    expect((await ws.exec("test ! -e aborted.txt")).exitCode).toBe(0);
  });

  it("rejects unknown exec options instead of silently dropping them", async () => {
    const ws = await shell(seededBackend());
    await expect(
      ws.exec("pwd", { typoedOption: true } as never),
    ).rejects.toThrow(/unknown workspace exec option: typoedOption/);
  });

  it("provides durable, workspace-confined file helpers", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    await ws.writeFiles([
      { path: "uploads/one.txt", content: "one" },
      { path: "/workspace/uploads/two.bin", content: new Uint8Array([116, 119, 111]) },
      { path: "uploads/empty.txt", content: "" },
    ]);
    expect(await ws.readFile("uploads/one.txt")).toBe("one");
    expect(await ws.readFile("/workspace/uploads/two.bin")).toBe("two");
    expect(await ws.readFile("uploads/empty.txt")).toBe("");
    await expect(ws.writeFiles([{ path: "../tmp/escape.txt", content: "x" }])).rejects.toThrow(
      /confined to \/workspace/,
    );
  });

  it("enforces read and write byte limits across the entire execution", async () => {
    const backend = seededBackend();
    backend.seedFile("/read-a.txt", "123456");
    backend.seedFile("/read-b.txt", "abcdef");
    const ws = await createLoonFsWorkspaceShell({
      backend,
      actor,
      access: "read-write",
      limits: { maxReadBytes: 10, maxWriteBytes: 10 },
    });

    const read = await ws.exec("cat read-a.txt read-b.txt");
    expect(read.exitCode).not.toBe(0);
    expect(read.stderr).toContain("10-byte aggregate read budget");
    expect(read.bytesRead).toBe(6);

    const write = await ws.exec("printf 123456 > write-a.txt; printf abcdef > write-b.txt");
    expect(write.exitCode).not.toBe(0);
    expect(write.stderr).toContain("10-byte aggregate write budget");
    expect(write.bytesWritten).toBe(6);
    expect((await ws.exec("cat write-a.txt")).stdout).toBe("123456");
    expect((await ws.exec("test ! -e write-b.txt")).exitCode).toBe(0);

    const copied = await ws.exec("cp read-a.txt copy-a.txt; cp read-b.txt copy-b.txt");
    expect(copied.exitCode).not.toBe(0);
    expect(copied.stderr).toContain("10-byte aggregate write budget");
    expect(copied.bytesWritten).toBe(6);
    expect((await ws.exec("cat copy-a.txt")).stdout).toBe("123456");
    expect((await ws.exec("test ! -e copy-b.txt")).exitCode).toBe(0);
  });

  it("registers only the curated command surface", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    for (const denied of ["ln -s a b", "touch stamp", "tar -cf a.tar contracts", "sqlite3 db", "python3 -c 1", "curl example.com"]) {
      const result = await ws.exec(denied);
      expect(result.exitCode, denied).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/not (found|available)/);
    }
    const allowed = await ws.exec("cat customers.json | jq -r '.customers[0].name' | tr a-z A-Z");
    expect(allowed.stdout).toBe("ACME\n");
  });

  it("translates workspace refusals into failed results instead of rejections", async () => {
    const backend = seededBackend();
    const readOnly = await shell(backend, "read-only");
    const refused = await readOnly.exec("echo x > blocked.txt");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("EROFS");
    expect(refused.stderr).toContain("read-only");
  });

  it("expands globs against the live workspace", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    expect((await ws.exec("cat *.json")).stdout).toBe('{"customers":[{"name":"Acme"}]}\n');
    expect((await ws.exec("echo *")).stdout).toBe("contracts customers.json\n");
    expect((await ws.exec("cat contracts/*.txt")).stdout).toBe("termination for convenience\n");
    expect((await ws.exec("find . -name '*.txt' | wc -l")).stdout.trim()).toBe("1");
  });

  it("keeps globs current across local and external mutations", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    await ws.exec("echo one > note-a.txt && mv note-a.txt note-c.txt");
    expect((await ws.exec("echo note-*.txt")).stdout).toBe("note-c.txt\n");
    backend.seedFile("/external.json", "{}");
    expect((await ws.exec("echo *.json")).stdout).toBe("customers.json external.json\n");
  });

  it("fails glob expansion loudly when a listing exceeds its bound", async () => {
    const backend = seededBackend();
    const ws = await createLoonFsWorkspaceShell({
      backend,
      actor,
      access: "read-write",
      limits: { maxDirectoryEntries: 1 },
    });
    // The over-limit listing keeps the pattern literal, so the command fails
    // visibly instead of acting on a partial expansion.
    const overflow = await ws.exec("cat *.json");
    expect(overflow.exitCode).not.toBe(0);
    expect(overflow.stderr).toContain("*.json");
    const explicit = await ws.exec("cat customers.json");
    expect(explicit.exitCode).toBe(0);
  });

  it("applies the configured traversal-entry bound to interpreter traversals", async () => {
    const backend = seededBackend();
    const ws = await createLoonFsWorkspaceShell({
      backend,
      actor,
      limits: { maxTraversalEntries: 1 },
    });
    const overflow = await ws.exec("find . -type f");
    expect(overflow.exitCode).not.toBe(0);
    expect(overflow.stderr).toContain("traversal entry limit exceeded (1)");
  });

  it("applies the configured interpreter output bound", async () => {
    const backend = seededBackend();
    const ws = await createLoonFsWorkspaceShell({
      backend,
      actor,
      limits: { maxOutputBytes: 8 },
    });
    const overflow = await ws.exec("printf 123456789");
    expect(overflow.exitCode).not.toBe(0);
    expect(overflow.stderr).toContain("limit exceeded (8 bytes)");
  });

  it("serializes executions so shared budgets stay coherent", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    const [a, b] = await Promise.all([
      ws.exec("mkdir -p a1 && echo one > a1/one.txt"),
      ws.exec("mkdir -p b1 && echo two > b1/two.txt && echo three > b1/three.txt"),
    ]);
    expect(a.mutations).toBe(2);
    expect(b.mutations).toBe(3);
    expect((await ws.exec("cat a1/one.txt b1/two.txt b1/three.txt")).stdout).toBe(
      "one\ntwo\nthree\n",
    );
  });

  it("refuses execution after close", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    await ws.close();
    await expect(ws.exec("pwd")).rejects.toThrow(/closed/);
  });

  it("rejects a root mount with an actionable configuration error", async () => {
    await expect(
      createLoonFsWorkspaceShell({
        backend: seededBackend(),
        actor,
        mountPoint: "/",
      }),
    ).rejects.toThrow(/mountPoint must name a directory below/);
  });

  it("rejects mounts that overlap reserved scratch and device paths", async () => {
    for (const mountPoint of ["/tmp", "/tmp/workspace", "/dev", "/dev/workspace"]) {
      await expect(
        createLoonFsWorkspaceShell({
          backend: seededBackend(),
          actor,
          mountPoint,
        }),
      ).rejects.toThrow(/cannot overlap the reserved \/tmp or \/dev trees/);
    }
  });
});
