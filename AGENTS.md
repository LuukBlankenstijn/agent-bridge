# Releasing

A release publishes to npm through `.github/workflows/publish.yml` when a GitHub release is published.

1. Bump the version in `package.json` and commit it. `flake.nix` reads its version from `package.json`.
2. Push that commit to `main`.
3. Create a GitHub release with tag `v<version>`, e.g. `gh release create v0.2.2 --target main --generate-notes`.

The workflow fails if the tag does not match the version in `package.json`.

Never run `npm publish` locally; CI publishes via npm trusted publishing (OIDC).
