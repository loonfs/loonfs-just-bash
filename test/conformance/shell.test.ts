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
    // A shell redirect is truncate-then-write: two guarded revisions.
    expect(write.mutations).toBe(2);
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
    const command = await ws.exec("workspace-info");
    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain("namespace: ns_customer_123");
    expect(command.stdout).toContain("posix_compatible: false");
    expect(command.stdout).toContain("append: bounded whole-file replacement");
  });

  it("keeps the workspace durable and the scratch space ephemeral", async () => {
    const backend = seededBackend();
    const first = await shell(backend);
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
    // Glob expansion is disabled until the session path index lands, so the
    // pattern stays literal and fails loudly instead of matching nothing.
    const glob = await readOnly.exec("cat *.json");
    expect(glob.exitCode).not.toBe(0);
    expect(glob.stderr).toContain("*.json");
  });

  it("serializes executions so shared budgets stay coherent", async () => {
    const backend = seededBackend();
    const ws = await shell(backend);
    const [a, b] = await Promise.all([
      ws.exec("mkdir -p a1 && echo one > a1/one.txt"),
      ws.exec("mkdir -p b1 && echo two > b1/two.txt && echo three > b1/three.txt"),
    ]);
    expect(a.mutations).toBe(3);
    expect(b.mutations).toBe(5);
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
});
