# loonfs-just-bash

A sandboxed workspace shell for operating on a durable, revisioned LoonFS
namespace. It uses familiar shell syntax but is not a POSIX filesystem.

```ts
import { LoonFSClient } from "@loonfs/sdk";
import { createLoonFsWorkspaceShell } from "@loonfs/just-bash";

const shell = await createLoonFsWorkspaceShell({
  client: new LoonFSClient({ environment: serverUrl, token }),
  namespaceId: "ns_customer_123",
  actor: { kind: "service", id: "agent_42" },
  access: "read-write", // the default is read-only
});

const result = await shell.exec('grep -rin "termination" /workspace/contracts', {
  toolCallId: "call_abc123",
  message: "Inspect contract termination clauses",
});
console.log(result.stdout, result.exitCode, result.searchModes);
await shell.close();
```

## The model

- `/workspace` is one LoonFS namespace: durable, revisioned, attributed.
  Every mutation carries the actor you configured, the execution's `message`
  as its commit message, and a revision or inode guard observed first. A
  guarded write that loses to another writer fails with a visible conflict;
  nothing ever degrades to an unguarded overwrite.
- `/tmp` and every other path are ephemeral in-memory scratch space. Copying
  from `/tmp` to `/workspace` publishes durable state.
- One `exec` at a time per shell; executions are serialized. Results carry
  head sequences, mutation and byte counters, and the search modes used.
- A shell redirect is truncate-then-write, so one `>` costs two revisions.
  Route write-heavy intermediate work through `/tmp`.
- Glob expansion walks live directory listings: matches are always current,
  and a listing past its bound fails the pattern loudly instead of matching
  a partial set.
- `grep -rin PATTERN /workspace/dir` routes to the server's content index
  when the deployment offers it (`loonfs-grep` invokes it directly); other
  forms run locally under the read, listing, and request budgets.

## What is deliberately unsupported

Symlinks, hard links, `chmod`, `touch`, and timestamp mutation fail with
`ENOTSUP`-style errors; mode bits shown by `stat` are display compatibility
only. Append is a bounded whole-file rewrite guarded by the revision that
was read, and refuses files past its limit. Archives, SQLite, language
runtimes, and network tools are not registered. Nothing fakes success.

## Command surface

| Available | Commands |
| --- | --- |
| Output | `echo` `printf` `cat` `head` `tail` `wc` `tee` |
| Files | `ls` `mkdir` `rmdir` `rm` `cp` `mv` `stat` `pwd` `basename` `dirname` |
| Search | `grep` `find` `tree` `du` `loonfs-grep` |
| Text | `awk` `sed` `cut` `sort` `uniq` `tr` `rev` `nl` `fold` `expand` `unexpand` `strings` `column` `join` `paste` `comm` `diff` |
| Data | `base64` `jq` `yq` `xan` |
| Shell | `env` `printenv` `true` `false` `expr` `seq` `bash` `sh` `help` `which` `workspace-info` |

Not registered: `ln` `readlink` `chmod` `touch` `gzip` `tar` `sqlite3`
`python` `node` `curl` and everything else. Pipes, redirections, `cd`,
conditionals, and loops are interpreter features and work normally.

## Limits

Defaults: 32 MiB reads and writes, 8 MiB append sources, 10,000 directory
entries per listing, 1,000 mutations and 2,000 LoonFS requests per
execution, 30s wall time, 2 MiB output. Reaching a limit fails the command
with an error that names the limit; nothing truncates silently. Override
through `limits` at creation.

## Development

`@loonfs/sdk` is not published yet; the dependency is a sibling clone, the
same arrangement the other LoonFS applications use:

```
git clone git@github.com:loonfs/loonfs-sdk-typescript ../loonfs-sdk-typescript
(cd ../loonfs-sdk-typescript && npm install && npm run build)
npm install
npm test
```

The integration suite runs automatically when a locally built server exists
at `../loonfs/target/debug/loonfs-server` (override with
`LOONFS_SERVER_BIN`); it starts a private server on a local-fs store, runs
the battery, and asserts guard conflicts against a second writer. A small
runnable example lives at `examples/design-partner.mjs`.
