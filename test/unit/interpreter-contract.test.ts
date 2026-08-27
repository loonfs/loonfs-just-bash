import { Bash, InMemoryFs } from "just-bash";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

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
    const mem = new InMemoryFs();
    const writes: string[] = [];
    const spy = new Proxy(mem, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || typeof property !== "string") {
          return value;
        }
        return (...args: unknown[]) => {
          if (property === "writeFile") {
            writes.push(JSON.stringify(args[1]));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const bash = new Bash({ fs: spy as InMemoryFs });
    await bash.exec("echo x > /f.txt");
    expect(writes).toEqual(['""', '"x\\n"']);
  });
});
