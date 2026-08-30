# Releasing

Build and inspect the package before every release:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm pack --dry-run
```

For trusted publishing, configure `@loonfs/just-bash` to trust
`.github/workflows/release.yml` in this repository. The `npm` GitHub
environment should require a maintainer's approval.

1. Bump `version` in `package.json` on main and merge the change.
2. Tag that commit `vX.Y.Z` and push the tag.
3. Run the **Publish package** workflow with that tag. It verifies that the
   tag matches `package.json` and publishes the package.
4. From an empty directory, run `npm install @loonfs/just-bash@X.Y.Z` and test
   destructive failure against a local server before handing the version to
   anyone. Use the integration suite's `LOONFS_SERVER_BIN` setup as the
   reference for starting the server. Seed a file through a shell with default
   limits, overwrite it through a shell with `limits: { maxWriteBytes: 8 }`,
   and confirm that the command fails, the file content is unchanged, and the
   namespace head did not advance.
