import { LoonFSClient, putFile } from "@loonfs/sdk/server";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HttpLoonFsBackend,
  LoonFsBackendError,
  createLoonFsWorkspaceShell,
} from "../../src/index.js";
import type { LoonFsBackend, LoonFsWorkspaceShell } from "../../src/index.js";

const SERVER_BIN =
  process.env.LOONFS_SERVER_BIN ?? resolve("../loonfs/target/debug/loonfs-server");
const TOKEN = "just-bash-integration-token";
const NAMESPACE = "ns_shell_it";
const actor = { kind: "service", id: "just-bash-it" } as const;

let serverProcess: ChildProcess | undefined;
let storeRoot: string | undefined;
let client: LoonFSClient;
let serverUrl: string;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function waitReady(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${url}/v0/capabilities`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Still starting.
    }
    if (Date.now() > deadline) {
      throw new Error("loonfs-server did not become ready in 20s");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function shell(access: "read-only" | "read-write" = "read-write"): Promise<LoonFsWorkspaceShell> {
  return createLoonFsWorkspaceShell({ client, namespaceId: NAMESPACE, actor, access });
}

describe.skipIf(!existsSync(SERVER_BIN))("hosted loonfs-server integration", () => {
  beforeAll(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "loonfs-just-bash-it-"));
    const port = await freePort();
    serverUrl = `http://127.0.0.1:${port}`;
    const configToml = [
      `bind = "127.0.0.1:${port}"`,
      `auth_token = "${TOKEN}"`,
      `content_token_secret = "just-bash-integration-content-secret"`,
      `writer_id = "just-bash-it-writer"`,
      "",
      "[store]",
      'kind = "local-fs"',
      `root = "${storeRoot}"`,
    ].join("\n");
    serverProcess = spawn(SERVER_BIN, ["--config-toml", configToml], { stdio: "ignore" });
    await waitReady(serverUrl);
    client = new LoonFSClient({ environment: serverUrl, token: TOKEN });
    await client.namespaces.createNamespace({ namespace_id: NAMESPACE });
  }, 40_000);

  afterAll(async () => {
    serverProcess?.kill();
    if (storeRoot !== undefined) {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("runs the workspace battery against the real server", async () => {
    const ws = await shell();
    const info = await ws.exec("workspace-info");
    expect(info.stdout).toContain(`namespace: ${NAMESPACE}`);
    const build = await ws.exec(
      [
        "mkdir -p reports/q3",
        "echo 'revenue: 12' > reports/q3/summary.md",
        "echo 'unicode café' > reports/q3/café.txt",
        "printf '' > reports/empty.txt",
        "echo scratch > /tmp/scratch.txt",
        "cp reports/q3/summary.md reports/q3/copy.md",
        "mv reports/q3/copy.md reports/q3/final.md",
        "echo 'appended' >> reports/q3/final.md",
      ].join(" && "),
    );
    expect(build.stderr).toBe("");
    expect(build.exitCode).toBe(0);
    expect(build.headSeqAfter).toBeGreaterThan(build.headSeqBefore ?? 0);
    const read = await ws.exec("cat reports/q3/final.md && cat reports/q3/café.txt && wc -c < reports/empty.txt");
    expect(read.stdout).toBe("revenue: 12\nappended\nunicode café\n0\n");
    await ws.close();
    // Durability outlives the shell; the scratch mount does not.
    const fresh = await shell();
    expect((await fresh.exec("cat reports/q3/final.md")).stdout).toBe("revenue: 12\nappended\n");
    expect((await fresh.exec("cat /tmp/scratch.txt")).exitCode).not.toBe(0);
    expect((await fresh.exec("echo reports/q3/*.md")).stdout).toBe(
      "reports/q3/final.md reports/q3/summary.md\n",
    );
  }, 30_000);

  it("keeps guards honest against an external writer", async () => {
    const raw = new HttpLoonFsBackend({ client, namespaceId: NAMESPACE });
    let interception: (() => Promise<void>) | undefined;
    const intercepted = new Proxy(raw, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || property !== "writeFile") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          if (interception !== undefined) {
            const run = interception;
            interception = undefined;
            await run();
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as LoonFsBackend;
    const ws = await createLoonFsWorkspaceShell({ backend: intercepted, actor, access: "read-write" });
    await ws.exec("echo 'draft one' > contested.txt");
    interception = async () => {
      await putFile(client, {
        namespace_id: NAMESPACE,
        path: "/contested.txt",
        bytes: new TextEncoder().encode("external edit\n"),
        actor: { kind: "user", id: "other-writer" },
        commit_id: crypto.randomUUID(),
        behavior: "replace",
      });
    };
    const conflict = await ws.exec("echo 'agent edit' > contested.txt");
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain("ESTALE");
    expect((await ws.exec("cat contested.txt")).stdout).toBe("external edit\n");
  }, 30_000);

  it("replays a committed mutation under its commit identity", async () => {
    const backend = new HttpLoonFsBackend({ client, namespaceId: NAMESPACE });
    const commit = { commitId: `c_${crypto.randomUUID().replaceAll("-", "")}`, actor };
    const first = await backend.createDirectory("/replayed", { parents: false, commit });
    const second = await backend.createDirectory("/replayed", { parents: false, commit });
    expect(second.headSeq).toBe(first.headSeq);
    const entry = await backend.stat("/replayed");
    expect(entry.kind).toBe("directory");
  }, 30_000);

  it("searches through the server index when the deployment offers it", async () => {
    const backend = new HttpLoonFsBackend({ client, namespaceId: NAMESPACE });
    const capabilities = await backend.getCapabilities();
    const ws = await shell();
    await ws.exec("mkdir -p contracts && echo 'termination for convenience' > contracts/acme.txt");
    if (capabilities.serverGrep) {
      const routed = await ws.exec('grep -rin "termination" /workspace/contracts');
      expect(routed.exitCode).toBe(0);
      expect(routed.stdout).toContain("/workspace/contracts/acme.txt:1:");
      expect(routed.searchModes).toEqual(["server_index"]);
    } else {
      const local = await ws.exec('grep -rin "termination" /workspace/contracts');
      expect(local.exitCode).toBe(0);
      expect(local.searchModes).toEqual(["bounded_local"]);
      const rejected = await ws.exec("loonfs-grep termination contracts");
      expect(rejected.exitCode).toBe(2);
      expect(rejected.searchModes).toEqual(["rejected"]);
    }
  }, 30_000);

  it("keeps read-only sessions read-only against the real server", async () => {
    const ws = await shell("read-only");
    const refused = await ws.exec("echo blocked > blocked.txt");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("EROFS");
    const error = await new HttpLoonFsBackend({ client: new LoonFSClient({ environment: serverUrl, token: "wrong-token" }), namespaceId: NAMESPACE })
      .stat("/")
      .catch((e: LoonFsBackendError) => e);
    expect((error as LoonFsBackendError).code).toBe("unauthenticated");
  }, 30_000);
});
