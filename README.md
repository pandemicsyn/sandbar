# Sandbar

Sandbar is a provider-neutral API for creating, controlling, and observing sandboxes across Daytona, E2B, Modal, Tensorlake, and future providers.

V1 is self-hosted and includes a management UI for provider credentials, fleet control, environments, policies, and accounting visibility. TypeScript, Rust, and Python are first-class client SDKs.

The selected architecture is a Bun/Hono TypeScript service with Drizzle, SQLite by default and a tested MySQL option. The management UI uses Vite, React, TanStack Router and Tailwind. Zod 4 validates public contracts and IO boundaries. Drizzle ORM and Kit target the verified `beta` tag, currently `1.0.0-beta.22`, pinned exactly at scaffolding.

**Status:** the base workspace, health endpoint, and prebuilt UI serving are scaffolded. The management UI, persistence, public resource API, SDKs, and verified provider adapters remain in development.

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
