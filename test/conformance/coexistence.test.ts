import { Bash, DefenseInDepthBox } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeLoonFsBackend, createLoonFsWorkspaceShell } from "../../src/index.js";

const actorId = "coexistence-test";

beforeEach(() => DefenseInDepthBox.resetInstance());
afterEach(() => DefenseInDepthBox.resetInstance());

describe("just-bash process coexistence", () => {
  it("runs a regular Bash after a LoonFS shell", async () => {
    const workspace = await createLoonFsWorkspaceShell({
      backend: new FakeLoonFsBackend(),
      actorId,
    });
    expect((await workspace.exec("pwd")).exitCode).toBe(0);
    expect((await new Bash().exec("echo regular")).stdout).toBe("regular\n");
  });

  it("runs a LoonFS shell after a regular Bash", async () => {
    expect((await new Bash().exec("echo regular")).stdout).toBe("regular\n");
    const workspace = await createLoonFsWorkspaceShell({
      backend: new FakeLoonFsBackend(),
      actorId,
    });
    expect((await workspace.exec("pwd")).stdout).toBe("/workspace\n");
  });
});
