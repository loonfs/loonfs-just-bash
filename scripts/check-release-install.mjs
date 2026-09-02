import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
const optionalPeers = packageJson.peerDependenciesMeta ?? {};

for (const [name, range] of Object.entries(packageJson.peerDependencies ?? {})) {
  if (optionalPeers[name]?.optional === true) {
    continue;
  }
  try {
    runNpm(["view", `${name}@${range}`, "version", "--json"], repository);
  } catch {
    throw new Error(
      `Required peer ${name}@${range} is not installable from npm. Publish that peer before releasing ${packageJson.name}.`,
    );
  }
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "loonfs-just-bash-release-"));
try {
  const packed = JSON.parse(
    runNpm(["pack", "--json", "--pack-destination", temporaryDirectory], repository),
  );
  // npm 10 reports an array of packed packages; npm 12 reports an object keyed by name.
  const [first] = Array.isArray(packed) ? packed : Object.values(packed);
  const filename = first?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report a tarball filename");
  }

  writeFileSync(
    join(temporaryDirectory, "package.json"),
    JSON.stringify({ name: "release-install-smoke-test", private: true, type: "module" }),
  );
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(temporaryDirectory, filename),
    ],
    temporaryDirectory,
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const packageModule = await import(${JSON.stringify(packageJson.name)}); if (typeof packageModule.createLoonFsWorkspaceShell !== "function") throw new Error("missing createLoonFsWorkspaceShell export");`,
    ],
    { cwd: temporaryDirectory, stdio: "inherit" },
  );
  console.log(`Verified a clean consumer install of ${packageJson.name}@${packageJson.version}.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function runNpm(args, cwd) {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
