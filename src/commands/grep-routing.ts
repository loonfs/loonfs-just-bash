import type { TransformPlugin } from "just-bash";

// Structural views of the AST nodes this plugin touches; the package root
// does not re-export the node types.
interface WordPartish {
  type: string;
  value?: string;
  parts?: WordPartish[];
}
interface Wordish {
  type: "Word";
  parts: WordPartish[];
}
interface SimpleCommandish {
  type: "SimpleCommand";
  name: Wordish | null;
  args: Wordish[];
}

export interface GrepRoutingMetadata {
  loonfsGrepRouting?: { routed: number; local: number };
}

/**
 * Rewrites eligible recursive grep invocations to loonfs-grep and counts the
 * ones it leaves for bounded local processing. Eligible means: literal words
 * only, flags within -rRin including a recursive flag, one pattern, and one
 * absolute path under the workspace mount.
 */
export function grepRoutingPlugin(options: {
  routeToServer: boolean;
  mountPoint: string;
}): TransformPlugin<GrepRoutingMetadata> {
  return {
    name: "loonfs-grep-routing",
    transform(context) {
      let routed = 0;
      let local = 0;
      walk(context.ast, (command) => {
        if (literalText(command.name) !== "grep") {
          return;
        }
        if (options.routeToServer && rewrite(command, options.mountPoint)) {
          routed += 1;
        } else {
          local += 1;
        }
      });
      return { ast: context.ast, metadata: { loonfsGrepRouting: { routed, local } } };
    },
  };
}

function rewrite(command: SimpleCommandish, mountPoint: string): boolean {
  let recursive = false;
  let caseInsensitive = false;
  let lineNumbers = false;
  const operands: Wordish[] = [];
  for (const word of command.args) {
    const text = literalText(word);
    if (text === undefined) {
      return false;
    }
    if (text.startsWith("-") && text.length > 1 && operands.length === 0) {
      if (text.startsWith("--")) {
        return false;
      }
      for (const letter of text.slice(1)) {
        if (letter === "r" || letter === "R") {
          recursive = true;
        } else if (letter === "i") {
          caseInsensitive = true;
        } else if (letter === "n") {
          lineNumbers = true;
        } else {
          return false;
        }
      }
      continue;
    }
    operands.push(word);
  }
  if (!recursive || operands.length !== 2) {
    return false;
  }
  const [pattern, path] = operands;
  const patternText = literalText(pattern!);
  const pathText = literalText(path!);
  if (patternText === undefined || new TextEncoder().encode(patternText).byteLength > 1024) {
    return false;
  }
  if (pathText === undefined || (pathText !== mountPoint && !pathText.startsWith(`${mountPoint}/`))) {
    return false;
  }
  command.name = literalWord("loonfs-grep");
  const flags = `${caseInsensitive ? "i" : ""}${lineNumbers ? "n" : ""}`;
  command.args = [...(flags === "" ? [] : [literalWord(`-${flags}`)]), pattern!, path!];
  return true;
}

function literalWord(value: string): Wordish {
  return { type: "Word", parts: [{ type: "Literal", value }] };
}

function literalText(word: Wordish | null): string | undefined {
  if (word === null) {
    return undefined;
  }
  let text = "";
  for (const part of word.parts) {
    const piece = literalPart(part);
    if (piece === undefined) {
      return undefined;
    }
    text += piece;
  }
  return text;
}

function literalPart(part: WordPartish): string | undefined {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "Escaped":
      return part.value ?? "";
    case "DoubleQuoted": {
      let text = "";
      for (const inner of part.parts ?? []) {
        const piece = literalPart(inner);
        if (piece === undefined) {
          return undefined;
        }
        text += piece;
      }
      return text;
    }
    default:
      return undefined;
  }
}

function walk(node: unknown, visit: (command: SimpleCommandish) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  if ((node as { type?: string }).type === "SimpleCommand") {
    visit(node as SimpleCommandish);
  }
  for (const value of Object.values(node)) {
    walk(value, visit);
  }
}
