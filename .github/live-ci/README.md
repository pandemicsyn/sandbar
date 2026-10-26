# Live CI

`.github/workflows/live-ci.yml` runs a real CI job on real providers. It is started by hand from
the Actions tab (**Live CI**, then **Run workflow**) and never runs on push or pull requests,
because it creates paid sandboxes.

Each provider job:

1. Builds the CLI and the provider's adapter from the chosen commit and installs them as packed
   tarballs (or, with `cli-version` set, installs that release through `actions/setup-sandbar`).
2. Restores the base snapshot record from the Actions cache, keyed on `bun.lock` and
   `prepare.sh`. On a miss it creates a sandbox, pushes the checkout, runs `prepare.sh` (Bun and
   `bun install`) and captures the `live-base` snapshot with `--replace`.
3. Creates the job sandbox from that snapshot, pushes the checkout on top, checks that exit codes
   pass through, then runs `test.sh`: lint, build and the CLI tests.
4. Copies `junit.xml` back and uploads it, removes the job's sandboxes, and runs `gc` on this
   run's label to check nothing was left behind.

It needs these repository secrets: `DAYTONA_API_KEY` and `E2B_API_KEY`. `DAYTONA_TARGET` defaults
to `us`; set a repository variable to change it.

Sandboxes are labelled `ci=sandbar-live`, so `sandbar gc --label ci=sandbar-live --older-than 2h`
sweeps anything a killed runner left. Each provider keeps one `live-base` snapshot between runs;
a dependency change replaces it.
