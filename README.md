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

## Quick start

Connect the shell to an existing namespace. It mounts that namespace at
`/workspace`.

```ts
import { LoonFSClient } from "@loonfs/sdk/server";
import { createLoonFsWorkspaceShell } from "@loonfs/just-bash";

const client = new LoonFSClient({
  environment: process.env.LOONFS_URL!,
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
- `/tmp` is private scratch space. It disappears with the shell.
- Pipes, redirects, variables, conditionals, loops, and `cd` work normally.
- One shell runs one `exec()` call at a time.
- Recursive `grep` uses LoonFS search when the server offers it. Other searches
  run inside the shell.
- Every execution has limits on runtime, output, reads, writes, directory
  listings, and LoonFS requests. You can override them with the `limits` option.

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

## Development

```sh
npm install
npm run lint
npm run typecheck
npm test
```

See [`examples/design-partner.mjs`](examples/design-partner.mjs) for a runnable
example. The integration tests use `../loonfs/target/debug/loonfs-server` when
it exists, or the server set in `LOONFS_SERVER_BIN`.

## License

Apache-2.0.
