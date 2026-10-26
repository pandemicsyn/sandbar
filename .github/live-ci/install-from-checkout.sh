#!/bin/sh
# Runs on the runner after `bun run build:packages`: installs the CLI and one adapter from this
# checkout, as packed tarballs, so the run tests unreleased code the way npm would install it.
# Usage: install-from-checkout.sh <provider> <prefix> <adapters-dir>
set -eu

provider=$1
prefix=$2
adapters=$3
packs=$(mktemp -d)

pack() {
  (cd "$1" && bun pm pack --quiet --destination "$packs" >/dev/null)
  ls -t "$packs"/*.tgz | head -n 1
}

adapter=$(pack packages/adapter)
sdk=$(pack packages/sdk)
cli=$(pack packages/cli)
provider_pack=$(pack "packages/providers/$provider")

flags="--no-audit --no-fund --save-exact"
mkdir -p "$prefix" "$adapters"
# Naming the workspace dependencies as tarballs keeps npm from fetching their released versions.
npm install --prefix "$prefix" $flags "$cli" "$sdk" "$adapter"
npm install --prefix "$adapters" $flags "$provider_pack" "$adapter"
echo "$prefix/node_modules/.bin"
