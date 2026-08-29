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
});
