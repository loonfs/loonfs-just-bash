import { Bash, InMemoryFs, MountableFs } from "just-bash";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeLoonFsBackend, LoonFsFileSystem } from "../../src/index.js";

let bash: Bash;

beforeEach(() => {
  const backend = new FakeLoonFsBackend({ namespaceId: "ns_test" });
  backend.seedFile("/contracts/acme.txt", "termination for convenience\nrenewal terms\n");
  backend.seedFile("/contracts/zenith.txt", "no termination clause here\n");
  backend.seedFile("/customers.json", '{"customers":[{"name":"Acme"},{"name":"Zenith"}]}\n');
  const workspace = new LoonFsFileSystem({ backend });
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [{ mountPoint: "/workspace", filesystem: workspace }],
  });
  bash = new Bash({ fs, cwd: "/workspace" });
});

describe("read-only commands over the workspace", () => {
  it("browses with pwd, ls, and stat", async () => {
    expect((await bash.exec("pwd")).stdout).toBe("/workspace\n");
    const ls = await bash.exec("ls /workspace/contracts");
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toBe("acme.txt\nzenith.txt\n");
    const stat = await bash.exec("stat /workspace/contracts/acme.txt");
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout).toContain("acme.txt");
  });

  it("reads with cat, head, tail, and wc", async () => {
    expect((await bash.exec("cat contracts/acme.txt")).stdout).toBe(
      "termination for convenience\nrenewal terms\n",
    );
    expect((await bash.exec("head -1 contracts/acme.txt")).stdout).toBe(
      "termination for convenience\n",
    );
    expect((await bash.exec("tail -1 contracts/acme.txt")).stdout).toBe("renewal terms\n");
    expect((await bash.exec("wc -l < contracts/acme.txt")).stdout.trim()).toBe("2");
  });

  it("walks with find, tree, and du", async () => {
    const find = await bash.exec("find /workspace -name '*.txt'");
    expect(find.exitCode).toBe(0);
    expect(find.stdout.split("\n").filter(Boolean).sort()).toEqual([
      "/workspace/contracts/acme.txt",
      "/workspace/contracts/zenith.txt",
    ]);
    expect((await bash.exec("tree /workspace")).stdout).toContain("acme.txt");
    expect((await bash.exec("du /workspace")).exitCode).toBe(0);
  });

  it("searches and filters through pipelines", async () => {
    const grep = await bash.exec("grep -n termination contracts/acme.txt contracts/zenith.txt");
    expect(grep.exitCode).toBe(0);
    expect(grep.stdout).toContain("contracts/acme.txt:1:");
    const jq = await bash.exec("cat customers.json | jq -r '.customers[] | .name'");
    expect(jq.stdout).toBe("Acme\nZenith\n");
    const pipeline = await bash.exec("cat contracts/acme.txt | wc -l");
    expect(pipeline.stdout.trim()).toBe("2");
  });

  it("carries LoonFS absence and read-only refusals into command results", async () => {
    const missing = await bash.exec("cat /workspace/missing.txt");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("missing.txt");
    // just-bash surfaces redirection-target write errors as exec rejections;
    // the workspace shell wrapper will translate these into exit codes.
    await expect(bash.exec("echo x > /workspace/out.txt")).rejects.toThrow(/EROFS/);
    const scratch = await bash.exec("echo scratch > /tmp/note.txt && cat /tmp/note.txt");
    expect(scratch.stdout).toBe("scratch\n");
  });
});
