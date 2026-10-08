# Working in Sandbar

Sandbar is a TypeScript SDK for working with sandbox providers.

## Find your way

- `packages/sdk` — public SDK and built-in provider entrypoints.
- `packages/adapter` — public adapter authoring API and conformance helpers.
- `packages/providers/*` — provider implementations and native-boundary fixtures.
- `apps/docs` — public documentation.
- [specs/README.md](specs/README.md) — contracts and proposals; [package conventions](specs/package-conventions.md) — public names and boundaries. Git history preserves superseded plans.
- [.agents/skills](.agents/skills) — task guidance, including [provider research briefs](.agents/skills/provider-research/SKILL.md) and [adding built-in or external providers](.agents/skills/add-provider/SKILL.md).

## SDK experience

Sandbar should let applications switch providers with changes concentrated in adapter setup. Use a small, consistent SDK vocabulary and sensible native defaults; adapters handle provider mechanics. Put meaningful provider choices in adapter configuration rather than requiring capability negotiation, permission flags, or native options throughout application code. Document each adapter's defaults, guarantees, and limitations. Report unsupported operations clearly, preserve confirmed outcomes and resource identities, and never hide a replacement resource or silently weaken an explicitly configured guarantee. Prefer this experience over exact parity between native APIs.

## Make changes

Read the relevant package, nearby tests and docs before editing. Use tested examples for available behavior; proposals do not authorize new features.

Keep changes focused. Preserve unrelated edits and coordinate shared files. Follow the linked contracts rather than duplicating architecture rules here.

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
