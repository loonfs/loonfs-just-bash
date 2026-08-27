import { fsError } from "./errors.js";

/**
 * Lexical POSIX normalization clamped at the root, so no input can name a
 * parent of the mount. The backend refuses anything non-normalized anyway.
 */
export function normalizeVirtualPath(path: string, syscall: string): string {
  if (path.includes("\0")) {
    throw fsError("EINVAL", "invalid argument", syscall, path);
  }
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const resolved: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return `/${resolved.join("/")}`;
}

export function joinVirtualPaths(base: string, path: string): string {
  if (path.startsWith("/")) {
    return normalizeVirtualPath(path, "resolve");
  }
  return normalizeVirtualPath(`${base}/${path}`, "resolve");
}

/** Maps a normalized virtual path to its namespace path beneath the root. */
export function toNamespacePath(virtualPath: string, namespaceRoot: string): string {
  if (namespaceRoot === "/") {
    return virtualPath;
  }
  return virtualPath === "/" ? namespaceRoot : `${namespaceRoot}${virtualPath}`;
}
