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

Edit the executable contract in `packages/contracts/src/openapi.ts`, run `bun run --cwd packages/contracts openapi:generate`, then `bun run --cwd apps/docs reference:generate` when routes change. Commit both generated artifacts. Do not edit the generated HTTP reference by hand.

## Cloudflare Workers Static Assets

`wrangler.jsonc` points at `./dist` and configures `404-page` fallback. There is no Worker entry point. To inspect routing locally after a build, use a Wrangler 4 installation and run `wrangler dev --config apps/docs/wrangler.jsonc` from the repository root (or run it in `apps/docs` with `--config wrangler.jsonc`). Unknown paths should return HTTP 404 with the generated `404.html`.

`sandbarsdk.dev` is already configured on Cloudflare. Production launch still requires a separate authorization. At that point, choose a protected release branch, deploy the built assets with Wrangler, bind the existing domain to the documentation Worker, and verify the live DNS route, HTTPS, redirects, search and 404 behavior. Worker binding and live serving have not been verified by this branch. Keep production account credentials in a protected deployment environment. Pull request checks only build and test; they receive no deployment credentials. Preview deployments, if introduced, should use `noindex` and must not publish an unmerged stack to the canonical domain. The current development landing page already has `noindex` while the stack is unpublished.
