# Working in Sandbar

Sandbar is a TypeScript SDK for working with sandbox providers, with an optional service and management UI.

## Find your way

- `packages/sdk` — public SDK and built-in provider entrypoints.
- `packages/adapter` — public adapter authoring API and conformance helpers.
- `packages/providers/*` — provider implementations and native-boundary fixtures.
- `packages/service`, `packages/service-runtime`, `packages/store` — optional service and persistence.
- `apps/server`, `apps/web`, `apps/docs` — HTTP server, management UI and public documentation.
- [specs/README.md](specs/README.md) — contracts and proposals; [package conventions](specs/package-conventions.md) — public names and boundaries. Archives are historical context.
- [.agents/skills](.agents/skills) — task guidance, including [provider research briefs](.agents/skills/provider-research/SKILL.md) and [adding built-in or external providers](.agents/skills/add-provider/SKILL.md).

## Make changes

Read the relevant package, nearby tests and docs before editing. Use tested examples for available behavior; proposals do not authorize new features.

Keep changes focused. Preserve unrelated edits and coordinate shared files. Keep the SDK independent of the service; follow the linked contracts rather than duplicating architecture rules here.

## Validate and hand off

Use the Bun version in `package.json` and install with `bun install --frozen-lockfile`. Root scripts provide:

- `bun run check` — package builds and TypeScript checks.
- `bun run test` — builds and tests; use focused tests during iteration.
- `bun run lint` and `bun run format:check` — source checks.
- `bun run package:smoke` — packed consumer qualification for package/API changes.
- `bun run docs:check` — public docs, generated references and examples.

Run relevant checks and required CI gates. Run shared builds sequentially; avoid repository-wide formatting for small changes.

Review the diff, update affected docs/tests, and report results and untested behavior. Follow task-specific review and merge requirements; no particular editor, agent or model is required by this file.

Use deterministic fixtures. Live provider calls, paid resources, publication and deployment require explicit authorization. Never commit secrets or erase user data during setup/testing.
