# Sandbar documentation site

This workspace builds the development documentation at the canonical origin `https://sandbarsdk.dev`. It is static Astro 7 with Starlight 0.42 and Pagefind. The landing page is `/`; curated docs are under `/docs/`. It has no runtime dependency on the Sandbar service or management UI.

## Work locally

From the repository root, install Bun 1.3.14 and run:

```sh
bun install --frozen-lockfile
bun run docs:check
bun run --cwd apps/docs dev
```

`docs:check` builds public workspace packages, checks Astro content and TypeScript examples, validates internal Markdown routes and anchors, checks generated OpenAPI reference drift, builds the static site and Pagefind index, checks output, and runs direct/remote quickstart flows against temporary fake and service processes. The fake is a simulation only.

Edit the executable contract in `apps/server/src/openapi.ts`, run `bun run --cwd apps/server openapi:generate`, then `bun run --cwd apps/docs reference:generate` when routes change. Commit both generated artifacts. Do not edit the generated HTTP reference by hand.

## Cloudflare Workers Static Assets

`wrangler.jsonc` points at `./dist` and configures `404-page` fallback. There is no Worker entry point. To inspect routing locally after a build, use a Wrangler 4 installation and run `wrangler dev --config apps/docs/wrangler.jsonc` from the repository root (or run it in `apps/docs` with `--config wrangler.jsonc`). Unknown paths should return HTTP 404 with the generated `404.html`.

The `sandbar-docs` Worker serves `sandbarsdk.dev` and `www.sandbarsdk.dev`; both are bound as custom domains in `wrangler.jsonc`, so a deploy keeps them attached. Pages canonicalize to `https://sandbarsdk.dev/`.

`.github/workflows/docs-deploy.yml` deploys on pushes to `main` that change `apps/docs/**`, `bun.lock` or the workflow itself, and can be run manually. It reruns `bun run docs:check` before `wrangler deploy`. It reads `CLOUDFLARE_API_TOKEN` (Workers Scripts edit and Workers Custom Domains/Zone edit for `sandbarsdk.dev`) and `CLOUDFLARE_ACCOUNT_ID` from the protected `production` GitHub environment. Pull request checks only build and test; they receive no deployment credentials. Preview deployments, if introduced, should use `noindex` and must not publish an unmerged stack to the canonical domain. Every page keeps `noindex` until public launch is decided.
