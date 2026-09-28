# Changesets

Run `bun run changeset` for every user-visible change to a package in the public 1.0 release group. Select every affected package, choose a semver bump, and write a sentence a reader can understand. Private apps, provider fixtures, and storage workspaces do not get changesets. `sandbar-service` is a public package and does. Version preparation consumes these files and updates package changelogs.

The experimental `sandbar-modal` package is outside the SDK, adapter, and service fixed group and outside `scripts/release-packages.json`. Its packed artifact is qualified separately. The manual 1.0 release workflow does not version or publish it; an independent release process must be prepared and authorized before publication.
