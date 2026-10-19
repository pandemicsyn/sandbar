# Changesets

Run `bun run changeset` for every user-visible change to a package in the public 1.0 release group. Select every affected package, choose a semver bump, and write a sentence a reader can understand. Private apps and provider fixtures do not get changesets. Version preparation consumes these files and updates package changelogs.

The experimental `@sandbar-sdk/modal` package is in the fixed group and `scripts/release-packages.json`, so it is versioned and published with the other public packages.
