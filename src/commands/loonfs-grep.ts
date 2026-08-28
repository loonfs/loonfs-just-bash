import { defineCommand } from "just-bash";
import type { GrepPage, LoonFsBackend } from "../backend/backend.js";
import { mapBackendError } from "../fs/errors.js";
import type { MutationContext } from "../fs/mutation-context.js";
import { normalizeVirtualPath, toNamespacePath } from "../fs/path.js";

export interface LoonFsGrepDeps {
  backend: LoonFsBackend;
  serverGrep: boolean;
  mountPoint: string;
  namespaceRoot: string;
  context: MutationContext;
}

const MAX_MATCHES = 1000;

/**
 * Server-indexed recursive search: matches come from LoonFS query.grep, so
 * no candidate file is downloaded through the filesystem adapter.
 */
export function loonfsGrepCommand(deps: LoonFsGrepDeps): ReturnType<typeof defineCommand> {
  return defineCommand("loonfs-grep", async (args, ctx) => {
    let caseInsensitive = false;
    let lineNumbers = false;
    const operands: string[] = [];
    let flagsDone = false;
    for (const arg of args) {
      if (!flagsDone && arg === "--") {
        flagsDone = true;
        continue;
      }
      if (!flagsDone && arg.startsWith("-") && arg.length > 1) {
        for (const letter of arg.slice(1)) {
          if (letter === "i") {
            caseInsensitive = true;
          } else if (letter === "n") {
            lineNumbers = true;
          } else if (letter === "r" || letter === "R") {
            // Recursion is the only mode this command has.
          } else {
            return usage(`unsupported flag -${letter}`);
          }
        }
        continue;
      }
      operands.push(arg);
    }
    const [pattern, ...paths] = operands;
    if (pattern === undefined) {
      return usage("a pattern is required");
    }
    if (deps.serverGrep === false) {
      deps.context.recordSearchMode("rejected");
      return {
        stdout: "",
        stderr:
          "loonfs-grep: this deployment does not index content search; use grep for bounded local search\n",
        exitCode: 2,
      };
    }
    const prefixes: string[] = [];
    for (const path of paths.length > 0 ? paths : [ctx.cwd]) {
      const virtual = normalizeVirtualPath(
        path.startsWith("/") ? path : `${ctx.cwd}/${path}`,
        "grep",
      );
      if (virtual !== deps.mountPoint && !virtual.startsWith(`${deps.mountPoint}/`)) {
        deps.context.recordSearchMode("rejected");
        return {
          stdout: "",
          stderr: `loonfs-grep: ${path} is outside the ${deps.mountPoint} mount\n`,
          exitCode: 2,
        };
      }
      const underMount = virtual === deps.mountPoint ? "/" : virtual.slice(deps.mountPoint.length);
      prefixes.push(toNamespacePath(underMount, deps.namespaceRoot));
    }
    const lines: string[] = [];
    let truncated = false;
    let tailLagged = false;
    let lineTruncated = false;
    for (const prefix of prefixes) {
      let cursor: string | undefined;
      for (;;) {
        deps.context.countRequest("grep", prefix);
        let page: GrepPage;
        try {
          page = await deps.backend.grepNamespace!({
            pattern,
            caseInsensitive,
            pathPrefix: prefix,
            ...(cursor !== undefined ? { cursor } : {}),
          });
        } catch (error) {
          deps.context.recordSearchMode("rejected");
          throw mapBackendError(error, "grep", prefix);
        }
        if (!page.tailScanned) {
          tailLagged = true;
        }
        for (const match of page.matches) {
          if (match.lineTruncated) {
            lineTruncated = true;
          }
          if (lines.length >= MAX_MATCHES) {
            truncated = true;
            break;
          }
          const underRoot =
            deps.namespaceRoot === "/" ? match.path : match.path.slice(deps.namespaceRoot.length);
          const display = `${deps.mountPoint}${underRoot === "/" ? "" : underRoot}`;
          lines.push(
            lineNumbers ? `${display}:${match.lineNo}:${match.line}` : `${display}:${match.line}`,
          );
        }
        if (truncated || page.nextCursor === undefined) {
          break;
        }
        cursor = page.nextCursor;
      }
      if (truncated) {
        break;
      }
    }
    deps.context.recordSearchMode("server_index");
    let stderr = "";
    if (tailLagged) {
      stderr += "loonfs-grep: note: the search index lags the newest writes; recent revisions were not fully scanned\n";
    }
    if (truncated) {
      stderr += `loonfs-grep: results truncated at ${MAX_MATCHES} matches; narrow the pattern or prefix\n`;
    }
    if (lineTruncated) {
      stderr += "loonfs-grep: note: one or more matching lines were truncated by the server\n";
    }
    return {
      stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
      stderr,
      exitCode: lines.length > 0 ? 0 : 1,
    };
  });
}

function usage(reason: string): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: "",
    stderr: `loonfs-grep: ${reason}\nusage: loonfs-grep [-i] [-n] PATTERN [PATH...]\n`,
    exitCode: 2,
  };
}
