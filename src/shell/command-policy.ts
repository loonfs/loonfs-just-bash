import type { Bash } from "just-bash";

type BashConstructorOptions = NonNullable<ConstructorParameters<typeof Bash>[0]>;
export type AllowedCommand = NonNullable<BashConstructorOptions["commands"]>[number];

/**
 * The curated document-workspace surface. Links, touch, archives, SQLite,
 * language runtimes, and network tools stay unregistered; profiles can widen
 * this later, explicitly.
 */
export const WORKSPACE_COMMAND_ALLOWLIST: AllowedCommand[] = [
  "echo", "printf",
  "cat", "head", "tail", "wc",
  "ls", "mkdir", "rmdir", "rm", "cp", "mv", "stat",
  "pwd", "basename", "dirname",
  "grep", "find", "tree", "du",
  "awk", "sed", "cut", "sort", "uniq", "tr", "rev", "nl", "fold", "expand", "unexpand",
  "strings", "column", "join", "paste", "comm", "diff",
  "base64", "jq", "yq", "xan", "tee",
  "env", "printenv",
  "true", "false", "expr", "seq",
  "bash", "sh", "help", "which",
];
