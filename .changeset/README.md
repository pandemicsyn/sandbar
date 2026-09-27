# Changesets

Run `bun run changeset` for every user-visible change to a publishable package. Select every affected package, choose a semver bump, and write a sentence a reader can understand. Private apps, provider fixtures, and storage workspaces do not get changesets. `sandbar-service` is a public package and does. Version preparation consumes these files and updates package changelogs.
