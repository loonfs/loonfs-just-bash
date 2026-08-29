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
`.github/workflows/release.yml` in this repository. Create and push the
matching `vX.Y.Z` tag, then run the **Publish package** workflow with that tag.
The `npm` GitHub environment should require a maintainer's approval.
