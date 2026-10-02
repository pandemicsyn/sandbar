# Sandbar documentation site

This workspace builds the development documentation at the canonical origin `https://sandbarsdk.dev`. It is static Astro 7 with Starlight 0.42 and Pagefind. The landing page is `/`; curated docs are under `/docs/`.

## Work locally

From the repository root, install Bun 1.3.14 and run:

```sh
bun install --frozen-lockfile
bun run docs:check
bun run --cwd apps/docs dev
```

`docs:check` builds public workspace packages, checks Astro content and TypeScript examples, validates Markdown routes and anchors, checks generated TypeScript and provider evidence, builds the static site and Pagefind index, checks output, and runs SDK quickstart flows against temporary fake provider processes. The fake is a simulation only.

## Cloudflare Workers Static Assets

`wrangler.jsonc` points at `./dist` and configures `404-page` fallback. There is no Worker entry point. To inspect routing locally after a build, use a Wrangler 4 installation and run `wrangler dev --config apps/docs/wrangler.jsonc` from the repository root (or run it in `apps/docs` with `--config wrangler.jsonc`). Unknown paths should return HTTP 404 with the generated `404.html`.

The `sandbar-docs` Worker serves `sandbarsdk.dev` and `www.sandbarsdk.dev`; both are bound as custom domains in `wrangler.jsonc`, so a deploy keeps them attached. Pages canonicalize to `https://sandbarsdk.dev/`.

`.github/workflows/docs-deploy.yml` deploys on pushes to `main` that change `apps/docs/**`, `bun.lock` or the workflow itself, and can be run manually. It checks that deployment credentials are present, then reruns `bun run docs:check` before `wrangler deploy`. Pull request checks only build and test; they receive no deployment credentials. Preview deployments, if introduced, should use `noindex` and must not publish an unmerged stack to the canonical domain. Every page keeps `noindex` until public launch is decided.

Configure these **Actions secrets** in this repository's **Settings > Environments > production**:

- `CLOUDFLARE_API_TOKEN`: a deployment API token restricted to the existing production Cloudflare account. Grant Workers edit access for `sandbar-docs` and Workers Routes Write for the `sandbarsdk.dev` zone, as required to manage the configured custom domains. See [Cloudflare's deployment permissions](https://developers.cloudflare.com/workers/authorization/). Do not use a Global API key or an all-accounts token.
- `CLOUDFLARE_ACCOUNT_ID`: the ID of that same existing account, which owns `sandbar-docs` and the production domains. Keep the current Worker name and custom domains in `wrangler.jsonc`.

The workflow reads both names through `secrets`, so setting an Actions variable does not supply them. A missing secret fails the credential check with its name and setup location; values are never printed. This checks presence only, not token validity or permissions. Environment protection rules are configured separately in GitHub; declaring `environment: production` does not itself restrict branches or require approval. Review those rules before enabling deployment credentials. Provisioning credentials and running a deployment require explicit authorization; do not rerun the workflow as a credential test.

## Content structure

The public docs focus on the SDK: getting started, agent prompts, everyday guides,
provider setup and tested support, adapter authoring, and TypeScript reference.
The landing page is maintained separately in `src/pages/index.astro`.

The getting started page imports `examples/getting-started-{daytona,e2b,modal}.ts`
as its displayed code, so all three copyable examples are checked by the examples
TypeScript project. Synchronized provider tabs switch install, credentials, and
code together. The examples are not executed in offline checks because they
create real sandboxes. Installation copy describes the upcoming package release
until publication; contributor setup stays in this README.

Provider test evidence comes from the reviewed JSON files in
`packages/sdk-qualification/provider-qualification/results/`. After an authorized
run, update the provider's existing file and run the qualification renderer.
Keep `providers/support.md` consistent with those operation-level results. The
normal docs build checks drift and never calls live providers.
