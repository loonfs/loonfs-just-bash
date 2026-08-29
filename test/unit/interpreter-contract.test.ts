import { Bash, InMemoryFs } from "just-bash";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

function recordingFs(): { fs: InMemoryFs; writes: string[] } {
  const mem = new InMemoryFs();
  const writes: string[] = [];
  const spy = new Proxy(mem, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") {
        return value;
      }
      return (...args: unknown[]) => {
        if (property === "writeFile" || property === "appendFile") {
          writes.push(`${property}:${JSON.stringify(args[1])}`);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fs: spy as InMemoryFs, writes };
}

/**
 * Canaries for the empirical just-bash behaviors this package leans on.
 * An upgrade that changes any of them must be reviewed, not absorbed.
 */
describe("pinned interpreter contracts", () => {
  it("is the pinned just-bash version", () => {
    const require = createRequire(import.meta.url);
    const declared = require("../../package.json").dependencies["just-bash"];
    expect(declared).toBe("3.4.2");
  });

  it("expands globs through directory listings, never getAllPaths", async () => {
    const mem = new InMemoryFs();
    await mem.writeFile("/a.json", "1");
    const calls: string[] = [];
    const spy = new Proxy(mem, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || typeof property !== "string") {
          return value;
        }
        return (...args: unknown[]) => {
          calls.push(property);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const bash = new Bash({ fs: spy as InMemoryFs, cwd: "/" });
    expect((await bash.exec("echo *.json")).stdout).toBe("a.json\n");
    expect(calls).not.toContain("getAllPaths");
    expect(calls).toContain("readdirWithFileTypes");
  });

  it("keeps the message-prefix error convention", async () => {
    const mem = new InMemoryFs();
    const error = await mem.stat("/nope").catch((e: Error) => e);
    expect((error as Error).message).toBe("ENOENT: no such file or directory, stat '/nope'");
  });

  it("opens a redirection as truncate-then-write", async () => {
    const { fs, writes } = recordingFs();
    const bash = new Bash({ fs });
    await bash.exec("echo x > /f.txt");
    expect(writes).toEqual(['writeFile:""', 'writeFile:"x\\n"']);
  });

  it("completes an empty redirect with only the truncate write", async () => {
    const first = recordingFs();
    const printfResult = await new Bash({ fs: first.fs }).exec("printf '' > /f.txt");
    expect(printfResult.exitCode).toBe(0);
    expect(first.writes).toEqual(['writeFile:""']);

    const second = recordingFs();
    const falseResult = await new Bash({ fs: second.fs }).exec("false > /f.txt");
    expect(falseResult.exitCode).toBe(1);
    expect(second.writes).toEqual(['writeFile:""']);
  });

  it("aborts the whole script at an interpreter limit", async () => {
    const { fs, writes } = recordingFs();
    const bash = new Bash({
      fs,
      executionLimitProfile: "hardened",
      executionLimits: { maxLoopIterations: 16 },
    });
    const result = await bash.exec("seq 1 400 > /f.txt; echo done");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("bash: ");
    expect(result.stderr).toContain("iteration limit");
    expect(result.stdout).toBe("");
    expect(writes).toEqual(['writeFile:""']);
  });

  it("resolves a wall-clock timeout as exit 124", async () => {
    const { fs, writes } = recordingFs();
    const bash = new Bash({ fs, executionLimits: { maxExecutionTimeMs: 300 } });
    const result = await bash.exec("sleep 2 > /f.txt");
    expect(result.exitCode).toBe(124);
    expect(writes).toEqual(['writeFile:""']);
  });

  it("opens append as an empty append before the payload", async () => {
    const first = recordingFs();
    const echoResult = await new Bash({ fs: first.fs }).exec("echo x >> /f.txt");
    expect(echoResult.exitCode).toBe(0);
    expect(first.writes).toEqual(['appendFile:""', 'appendFile:"x\\n"']);

    const second = recordingFs();
    const colonResult = await new Bash({ fs: second.fs }).exec(": >> /f.txt");
    expect(colonResult.exitCode).toBe(0);
    expect(second.writes).toEqual(['appendFile:""']);
  });
});
