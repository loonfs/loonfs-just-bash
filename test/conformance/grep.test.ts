import { describe, expect, it } from "vitest";
import { FakeLoonFsBackend, createLoonFsWorkspaceShell } from "../../src/index.js";
import type { LoonFsWorkspaceShell } from "../../src/index.js";

const actor = { kind: "service", id: "agent_42" } as const;

function seeded(): FakeLoonFsBackend {
  const backend = new FakeLoonFsBackend({ namespaceId: "ns_search" });
  backend.seedFile(
    "/contracts/acme.txt",
    "Termination for convenience.\nRenewal terms follow.\ntermination fees apply.\n",
  );
  backend.seedFile("/contracts/nested/zenith.txt", "No termination clause.\n");
  backend.seedFile("/notes.md", "termination noted here\n");
  return backend;
}

function counted(backend: FakeLoonFsBackend): { proxy: FakeLoonFsBackend; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const proxy = new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return (...args: unknown[]) => {
        calls.set(property, (calls.get(property) ?? 0) + 1);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as FakeLoonFsBackend;
  return { proxy, calls };
}

async function shell(backend: FakeLoonFsBackend): Promise<LoonFsWorkspaceShell> {
  return createLoonFsWorkspaceShell({ backend, actor, access: "read-write" });
}

describe("server-indexed recursive search", () => {
  it("routes eligible recursive grep to the server without downloading candidates", async () => {
    const backend = seeded();
    backend.enableServerGrep({ pageSize: 2 });
    const { proxy, calls } = counted(backend);
    const ws = await shell(proxy);
    const result = await ws.exec('grep -rin "termination" /workspace/contracts');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "/workspace/contracts/acme.txt:1:Termination for convenience.",
        "/workspace/contracts/acme.txt:3:termination fees apply.",
        "/workspace/contracts/nested/zenith.txt:1:No termination clause.",
        "",
      ].join("\n"),
    );
    expect(result.searchModes).toEqual(["server_index"]);
    expect(calls.get("grepNamespace")).toBeGreaterThan(1);
    expect(calls.get("readFile") ?? 0).toBe(0);
  });

  it("serves loonfs-grep directly with relative paths and case control", async () => {
    const backend = seeded();
    backend.enableServerGrep();
    const ws = await shell(backend);
    const sensitive = await ws.exec("loonfs-grep -n Termination contracts");
    expect(sensitive.stdout).toBe("/workspace/contracts/acme.txt:1:Termination for convenience.\n");
    const none = await ws.exec("loonfs-grep missing-pattern contracts");
    expect(none.exitCode).toBe(1);
    expect(none.searchModes).toEqual(["server_index"]);
    const outside = await ws.exec("loonfs-grep pattern /tmp");
    expect(outside.exitCode).toBe(2);
    expect(outside.stderr).toContain("outside the /workspace mount");
    expect(outside.searchModes).toEqual(["rejected"]);
  });

  it("keeps ineligible and explicit-file searches local and bounded", async () => {
    const backend = seeded();
    backend.enableServerGrep();
    const { proxy, calls } = counted(backend);
    const ws = await shell(proxy);
    const inverted = await ws.exec('grep -rvn "Renewal" /workspace/contracts');
    expect(inverted.exitCode).toBe(0);
    expect(inverted.searchModes).toEqual(["bounded_local"]);
    const explicit = await ws.exec('grep -n "termination" contracts/acme.txt');
    expect(explicit.stdout).toBe("3:termination fees apply.\n");
    expect(explicit.searchModes).toEqual(["bounded_local"]);
    const piped = await ws.exec('cat notes.md | grep termination');
    expect(piped.stdout).toBe("termination noted here\n");
    expect(calls.get("grepNamespace") ?? 0).toBe(0);
    expect(calls.get("readFile")).toBeGreaterThan(0);
  });

  it("stays bounded and honest without the server index", async () => {
    const backend = seeded();
    const ws = await shell(backend);
    const local = await ws.exec('grep -rin "termination" /workspace/contracts');
    expect(local.exitCode).toBe(0);
    expect(local.stdout).toContain("acme.txt");
    expect(local.searchModes).toEqual(["bounded_local"]);
    const rejected = await ws.exec("loonfs-grep termination contracts");
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr).toContain("does not index content search");
    expect(rejected.searchModes).toEqual(["rejected"]);
  });

  it("surfaces an index that lags the newest writes", async () => {
    const backend = seeded();
    backend.enableServerGrep({ tailScanned: false });
    const ws = await shell(backend);
    const lagged = await ws.exec("loonfs-grep termination contracts");
    expect(lagged.exitCode).toBe(0);
    expect(lagged.stderr).toContain("lags the newest writes");
  });
});
