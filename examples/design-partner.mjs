// A minimal design-partner example: point it at a LoonFS deployment and it
// prepares a workspace, asks the shell some questions, and prints results.
//
//   LOONFS_URL=http://127.0.0.1:9400 LOONFS_TOKEN=... NAMESPACE=ns_demo \
//     node examples/design-partner.mjs
import { LoonFSClient } from "@loonfs/sdk/server";
import { createLoonFsWorkspaceShell } from "../dist/index.js";

const client = new LoonFSClient({
  environment: process.env.LOONFS_URL ?? "http://127.0.0.1:9400",
  token: process.env.LOONFS_TOKEN ?? "poc-token",
});
const namespaceId = process.env.NAMESPACE ?? "ns_just_bash_demo";
await client.namespaces.createNamespace({ namespace_id: namespaceId }).catch(() => {});

const shell = await createLoonFsWorkspaceShell({
  client,
  namespaceId,
  actor: { kind: "service", id: "design-partner-example" },
  access: "read-write",
});

for (const script of [
  "workspace-info",
  "mkdir -p contracts && echo 'termination for convenience' > contracts/acme.txt",
  'grep -rin "termination" /workspace/contracts',
  "ls contracts",
  "cat contracts/acme.txt | wc -w",
]) {
  const result = await shell.exec(script, { message: "design partner example" });
  console.log(`$ ${script}`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
await shell.close();
