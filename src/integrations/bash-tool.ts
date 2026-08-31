import type { LoonFsWorkspaceShell, WorkspaceFileInput } from "../types.js";

/** The structural sandbox contract consumed by Vercel's `bash-tool`. */
export interface BashToolSandbox {
  executeCommand(command: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  readFile(path: string): Promise<string>;
  writeFiles(files: WorkspaceFileInput[]): Promise<void>;
}

/**
 * Adapts a LoonFS workspace shell without exposing an `exec` property, so
 * bash-tool selects its custom Sandbox path rather than its just-bash wrapper.
 */
export function createBashToolSandbox(shell: LoonFsWorkspaceShell): BashToolSandbox {
  return {
    executeCommand: (command) => shell.exec(command),
    readFile: (path) => shell.readFile(path),
    writeFiles: (files) => shell.writeFiles(files, { message: "bash-tool file upload" }),
  };
}
