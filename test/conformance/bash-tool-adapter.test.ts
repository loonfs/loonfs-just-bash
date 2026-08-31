import { describe, expect, it } from "vitest";
import {
  FakeLoonFsBackend,
  createBashToolSandbox,
  createLoonFsWorkspaceShell,
} from "../../src/index.js";

describe("bash-tool sandbox adapter", () => {
  it("implements command, read, and batched durable write operations", async () => {
    const backend = new FakeLoonFsBackend();
    const shell = await createLoonFsWorkspaceShell({
      backend,
      actor: { kind: "service", id: "bash-tool-test" },
      access: "read-write",
    });
    const sandbox = createBashToolSandbox(shell);
    expect("exec" in sandbox).toBe(false);

    await sandbox.writeFiles([
      { path: "/workspace/input/a.txt", content: "alpha" },
      { path: "/workspace/input/b.txt", content: new Uint8Array([98, 101, 116, 97]) },
    ]);
    expect((await sandbox.executeCommand("cat input/a.txt input/b.txt")).stdout).toBe("alphabeta");
    expect(await sandbox.readFile("/workspace/input/b.txt")).toBe("beta");

    const fresh = await createLoonFsWorkspaceShell({
      backend,
      actor: { kind: "service", id: "fresh-reader" },
    });
    expect((await fresh.exec("cat input/a.txt")).stdout).toBe("alpha");
  });

  it("works as a custom sandbox in Vercel's bash-tool on the first call", async () => {
    const backend = new FakeLoonFsBackend();
    const shell = await createLoonFsWorkspaceShell({
      backend,
      actor: { kind: "service", id: "bash-tool-integration" },
      access: "read-write",
    });
    const toolkit = await createBashTool({
      sandbox: createBashToolSandbox(shell),
      destination: "/workspace",
      files: { "matter/summary.txt": "durable upload" },
    });

    expect(await toolkit.sandbox.readFile("/workspace/matter/summary.txt")).toBe(
      "durable upload",
    );
    expect(
      (await toolkit.sandbox.executeCommand("cat /workspace/matter/summary.txt")).stdout,
    ).toBe("durable upload");
    expect(Object.keys(toolkit.tools)).toEqual(["bash", "readFile", "writeFile"]);
  });
});
import { createBashTool } from "bash-tool";
