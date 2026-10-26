#!/bin/sh
# Runs inside the sandbox: the job's own CI work, on whatever the base already prepared.
set -eu

sh .github/live-ci/prepare.sh
export PATH="$HOME/.bun/bin:$PATH"

bun run lint
bun run build:packages
bun test packages/cli --reporter=junit --reporter-outfile=junit.xml
