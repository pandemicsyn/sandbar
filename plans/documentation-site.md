# Public documentation site

The initial public docs live in `apps/docs` and target `https://sandbarsdk.dev`. Astro builds static HTML and Starlight provides docs navigation, code display and Pagefind search. Cloudflare Workers Static Assets is the deployment target; no Workers code, database or SSR adapter is required.

The site is development documentation for the merged TypeScript SDK and service. It labels the fake provider as a simulation and does not claim published packages, real providers, Rust/Python SDKs or planned storage/accounting features. Key quickstart flows are checked in as typechecked, fake-backed examples. The HTTP route index is generated from `apps/server/src/openapi.ts`.

Build and test with `bun run docs:check`. `sandbarsdk.dev` is already configured on Cloudflare. The site remains unlaunched until a later instruction authorizes deployment, binding the existing domain to the documentation Worker and verifying live DNS routing and HTTPS. See [`apps/docs/README.md`](../apps/docs/README.md) for the build and launch procedure.
