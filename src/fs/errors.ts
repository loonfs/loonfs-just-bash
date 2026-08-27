import type { BackendConditionCode } from "../backend/backend.js";
import { LoonFsBackendError } from "../backend/backend.js";

export interface WorkspaceFsError extends Error {
  code: string;
  loonfsCode?: BackendConditionCode;
  requestId?: string;
}

/**
 * just-bash filesystems signal conditions through the message prefix
 * ("ENOENT: no such file or directory, stat '/x'"), so the format matters
 * as much as the code property.
 */
export function fsError(
  code: string,
  description: string,
  syscall: string,
  path: string,
): WorkspaceFsError {
  const error = new Error(`${code}: ${description}, ${syscall} '${path}'`) as WorkspaceFsError;
  error.code = code;
  return error;
}

const CONDITIONS: Record<BackendConditionCode, { code: string; description: string }> = {
  not_found: { code: "ENOENT", description: "no such file or directory" },
  destination_exists: { code: "EEXIST", description: "file already exists" },
  not_a_directory: { code: "ENOTDIR", description: "not a directory" },
  is_a_directory: { code: "EISDIR", description: "illegal operation on a directory" },
  directory_not_empty: { code: "ENOTEMPTY", description: "directory not empty" },
  stale_revision: {
    code: "ESTALE",
    description: "changed after it was read; retry after re-reading the current revision",
  },
  raced_binding: {
    code: "ESTALE",
    description: "was renamed or replaced after it was read; retry against the current entry",
  },
  invalid_path: { code: "EINVAL", description: "invalid argument" },
  unsupported: { code: "ENOTSUP", description: "operation not supported by LoonFS" },
  unauthenticated: {
    code: "EACCES",
    description: "the LoonFS credential was refused; the session needs a valid token",
  },
  access_denied: { code: "EACCES", description: "permission denied" },
  busy: { code: "EAGAIN", description: "the server asked this session to retry later" },
  content_too_large: { code: "EFBIG", description: "file too large" },
  writer_fenced: {
    code: "LOONFS_WRITER_FENCED",
    description: "the namespace writer was fenced; this session must not continue writing",
  },
  internal: { code: "EIO", description: "input/output error" },
};

export function mapBackendError(error: unknown, syscall: string, path: string): Error {
  if (!(error instanceof LoonFsBackendError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const condition = CONDITIONS[error.code];
  const mapped = fsError(condition.code, condition.description, syscall, path);
  mapped.loonfsCode = error.code;
  if (error.requestId !== undefined) {
    mapped.requestId = error.requestId;
  }
  return mapped;
}

export function isBackendCondition(error: unknown, code: BackendConditionCode): boolean {
  return error instanceof LoonFsBackendError && error.code === code;
}
