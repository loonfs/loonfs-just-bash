# @loonfs/just-bash

Use Bash-style commands to read and change files in a LoonFS namespace.

This package is designed for AI agents that already know how to use commands
like `ls`, `cat`, `grep`, `sed`, and `jq`. The files live in LoonFS instead of
on the machine running the agent, so they survive process restarts and keep
their normal LoonFS history.

The shell runs inside your Node.js application. Shell commands cannot see the
host filesystem, start arbitrary programs, or make arbitrary network requests.

## Install

```sh
npm install @loonfs/just-bash
```

The package is ESM-only and needs Node 20.18.1 or newer. TypeScript consumers
need `"type": "module"` (or another ESM setup) for the top-level `await` in the
examples.

## Quick start

Connect the shell to an existing namespace. It mounts that namespace at
`/workspace`. The shell checks the server during creation and refuses to attach
when the server does not speak LoonFS API v0.3.x.

```ts
import { LoonFSClient } from "@loonfs/sdk/server";
import { createLoonFsWorkspaceShell } from "@loonfs/just-bash";

const client = new LoonFSClient({
  baseUrl: process.env.LOONFS_URL!,
  token: process.env.LOONFS_TOKEN!,
});

const shell = await createLoonFsWorkspaceShell({
  client,
  namespaceId: "ns_customer_123",
  actor: { kind: "service", id: "agent_42" },
  access: "read-write",
});

const result = await shell.exec('grep -rin "termination" /workspace/contracts', {
  message: "Inspect contract termination clauses",
});

console.log(result.stdout);
console.error(result.stderr);
console.log(`exit code: ${result.exitCode}`);

await shell.close();
```

The shell is read-only unless you set `access: "read-write"`. Writes are
attributed to the configured `actor`, and the optional `message` is stored with
them. If another writer changes the same file first, the command fails with a
conflict instead of silently replacing their work.

## How the workspace behaves

- `/workspace` contains the LoonFS namespace. Changes there are durable.
- `$HOME` points at `/workspace`, so `~/file.txt` is durable too.
- `/tmp` is the only writable scratch space. It disappears with the shell;
  writes elsewhere in the virtual root are refused instead of being silently
  lost when the shell closes.
- Pipes, redirects, variables, conditionals, loops, and `cd` work normally.
- Redirected output becomes one durable revision when the command finishes. A
  script that exits nonzero keeps every pre-existing file at its previous
  revision unless a command produced new content for it; discarded truncations
  are noted on stderr.
- Every change is a LoonFS revision. Earlier revisions of a file stay
  retrievable through the LoonFS SDK and CLI.
- One shell runs one `exec()` call at a time.
- Recursive `grep` uses LoonFS search when the server offers it. Other searches
  run inside the shell.
- Every execution has limits on runtime, output, reads, writes, directory
  listings, and LoonFS requests. Read and write byte limits apply to the total
  execution as well as each individual file. You can override them with the
  `limits` option.

`exec()` accepts the same per-call `env`, `replaceEnv`, `cwd`, `rawScript`,
`stdin`, `stdinKind`, `signal`, and `args` options as `just-bash`, plus LoonFS
`message` and `toolCallId` metadata. Unknown option names reject the call so a
misspelling cannot silently weaken the intended execution setup.

## Use with Vercel bash-tool

Use the provided structural adapter when an AI SDK integration expects
Vercel's `bash-tool` `Sandbox` interface. Passing the workspace shell itself
does not work because it intentionally is not a raw `just-bash` `Bash` object.
Install `bash-tool` in the consuming application (`npm install bash-tool`);
the adapter is integration-tested against version 1.3.19.

```ts
import { createBashTool } from "bash-tool";
import {
  createBashToolSandbox,
  createLoonFsWorkspaceShell,
} from "@loonfs/just-bash";

const shell = await createLoonFsWorkspaceShell({
  client,
  namespaceId: "ns_customer_123",
  actor: { kind: "service", id: "agent_42" },
  access: "read-write",
});
const { mountPoint } = await shell.info();
const { tools } = await createBashTool({
  sandbox: createBashToolSandbox(shell),
  destination: mountPoint,
  files: { "matter/README.md": "Matter workspace" },
});
```

The adapter's `readFile` and `writeFiles` methods are confined to the durable
workspace mount. Commands can still use `/tmp` for bounded scratch work. Close
the underlying `shell` when the agent session ends.

## Available commands

| Available | Commands |
| --- | --- |
| Output | `echo` `printf` `cat` `head` `tail` `wc` `tee` |
| Files | `ls` `mkdir` `rmdir` `rm` `cp` `mv` `stat` `pwd` `basename` `dirname` |
| Search | `grep` `find` `tree` `du` `loonfs-grep` |
| Text | `awk` `sed` `cut` `sort` `uniq` `tr` `rev` `nl` `fold` `expand` `unexpand` `strings` `column` `join` `paste` `comm` `diff` |
| Data | `base64` `jq` `yq` `xan` |
| Shell | `env` `printenv` `true` `false` `expr` `seq` `bash` `sh` `help` `which` `workspace-info` |

Only the commands above are available. Tools such as `python`, `node`, `curl`,
`sqlite3`, `tar`, and `gzip` are not included. Symlinks, hard links, and Unix
permission changes are also unsupported.

## Limits

By default, each `exec()` call may run for 30 seconds, print 2 MiB of output,
and read or write 32 MiB. There are also bounds on directory listings, file
appends, writes, and LoonFS requests. Reaching a limit returns an error instead
of silently truncating the result.

Pass `limits` when creating the shell to change any of these defaults.
Interpreter bounds are configurable too (`maxCommandCount`,
`maxLoopIterations`, `maxTraversalEntries`). Run `workspace-info` inside the
shell to see the effective limits.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
```

Before publishing, `npm run release:check` verifies that required peer versions
exist on npm and installs the packed tarball in a clean temporary consumer.

Run `npm run example` for a runnable example. It builds first and then runs
[`examples/design-partner.mjs`](examples/design-partner.mjs). The integration
tests use `../loonfs/target/debug/loonfs-server` when it exists, or the server
set in `LOONFS_SERVER_BIN`.

## License

Apache-2.0.
