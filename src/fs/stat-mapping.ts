import type { FsStat } from "just-bash";
import type { LoonFsEntry } from "../backend/backend.js";

/**
 * Mode bits are display compatibility only; LoonFS has no authorization or
 * executable state. Directory mtime is the creation time, an approximation.
 */
export function statFromEntry(entry: LoonFsEntry, namespaceId: string): FsStat {
  const isFile = entry.kind === "file";
  const stat: FsStat = {
    isFile,
    isDirectory: !isFile,
    isSymbolicLink: false,
    mode: isFile ? 0o644 : 0o755,
    size: entry.file?.sizeBytes ?? 0,
    mtime: new Date(entry.file?.committedAtMs ?? entry.createdAtMs),
    identity: `${namespaceId}:${entry.inodeId}`,
  };
  const numeric = /^ino_(\d+)$/.exec(entry.inodeId);
  if (numeric) {
    stat.ino = BigInt(numeric[1]!);
  }
  return stat;
}
