# Sandbar

Sandbar is a provider-neutral API for creating, controlling, and observing sandboxes across Daytona, E2B, Modal, Tensorlake, and future providers.

V1 is self-hosted and includes a management UI for provider credentials, fleet control, environments, policies, and accounting visibility. TypeScript, Rust, and Python are first-class client SDKs.

The selected architecture is a Bun/Hono TypeScript service with Drizzle, SQLite by default and a tested MySQL option. The management UI uses Vite, React, TanStack Router and Tailwind. Zod 4 validates public contracts and IO boundaries. Drizzle ORM and Kit target the verified `beta` tag, currently `1.0.0-beta.22`, pinned exactly at scaffolding.

**Status:** the base workspace, health endpoint, and prebuilt UI serving are scaffolded. The management UI, persistence, public resource API, SDKs, and verified provider adapters remain in development.

## Local checks

Use Bun 1.3.14 and Node.js 22, then run `bun install --frozen-lockfile` before checking a checkout. Oxfmt uses Node.js to format HTML. CI runs these same commands:

```sh
bun run lint
bun run format:check
bun run check
bun run test
bun run build
```

`check` typechecks the workspace packages. To apply safe lint fixes, run `bun run lint:fix`; to format supported source and configuration files, run `bun run format`. Historical material in `docs/archive` is excluded from linting. The root README, `docs/` prose, and generated OpenAPI and HTTP reference files are excluded from Oxfmt.

Lint also runs the [vendored anti-slop Oxlint rules](tools/oxlint/anti-slop/UPSTREAM.md), including Effect rules for future Effect code. The plugin source and licenses live in `tools/oxlint/anti-slop/` as repository-owned tooling.

## Design documents

- [V1 contract recommendations and review decisions](docs/contract-recommendations.md)
- [Storage, snapshots, and user-supplied images](docs/storage-and-images.md)
- [Observability, usage, and accounting](docs/observability-and-accounting.md)
- [Management UI scope and workflows](docs/management-ui.md)
- [Selected architecture and stack](docs/design.md)
- [Validation boundaries and executable contracts](docs/validation-and-contracts.md)
- [Public API specification](docs/api-spec.md)
- [Provider drivers and research](docs/provider-drivers.md)
- [Implementation plan](docs/implementation-plan.md)

The new strategy documents refine the earlier drafts; recommendations are marked as proposals, with provider guarantees pending live conformance. The current documents supersede the [original design and TypeScript sketches](docs/archive/README.md). Proposed API names and routes remain subject to contract review.

See [LICENSE](LICENSE) for the repository license.
