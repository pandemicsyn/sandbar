# Sandbar working agreements

## Second implementation wave: direct TypeScript SDK

The reviewed first-wave PRs #1–#4 remain an unmerged stack. Build the next stack on `codex/web-e2e` at `dbd2ee66c76e4f1cd2e340bede75ad699dbdfcc7`: portable core extraction, TypeScript SDK, then Node/Bun and package qualification. Follow `docs/direct-typescript-sdk.md`. Direct mode runs against provider drivers from the caller's process without the Sandbar service, database, or hidden process. The initial verified driver is the independent fake; real provider support is not implied. Service-owned coordination, store access, credential custody, and encryption stay outside `@sandbar/core` and the direct dependency graph.

- Portable core and service runtime task: `01a0decc-8ab3-7202-9ef9-a84c5ea95c12`, owning `packages/core`, `packages/service-runtime`, service composition, plan adoption, and initial root package/lock changes.
- TypeScript SDK task: `01a0decd-04b4-7c61-b305-ea7fdcf5b5b4`, owning `packages/sdk`, its direct/remote entry points, and the fake provider client/server split.
- Node/Bun qualification task: `01a0decd-90d2-7761-9736-8560f7ead2b5`, owning parity/packed-consumer tests, CI and measured runtime documentation.
- Coordinate through manager chat `01a0db94-f78d-70f3-83dd-106d28e38da3`. Exchange package interfaces and checkpoint refs before integration. Each new PR targets its immediate parent explicitly and passes the mandatory review gate below.

## First implementation wave

Build a coherent fake-provider vertical slice in a stacked sequence: foundation, public contracts and fake provider, durable control and SQL, then management UI and end-to-end flows. Keep API wire contracts separate from database rows. Use Bun/Hono, Zod 4 at IO boundaries, Drizzle ORM and Kit pinned to `1.0.0-beta.22`, SQLite by default and a separately tested MySQL implementation. The UI uses Vite, React, Tailwind and TanStack Router. Real provider calls, production deployment, and paid usage are outside this wave.

## Ownership and integration

- Foundation task: `01a0de54-08f6-7702-92f5-d57e5d0c2804`.
- Contracts and fake provider task: `01a0de54-6131-79e1-a593-8e96b322ffa1`.
- Durable control and SQL task: `01a0de54-b8f6-7f20-91e0-de8657b28727`.
- Management UI and end-to-end task: `01a0de55-18c7-7e73-81d4-cbd2535cccbc`.
- Coordinate these tasks through manager chat `01a0db94-f78d-70f3-83dd-106d28e38da3`.
- Foundation owns root workspace config, lockfile, CI, initial server composition and asset serving, README and docs.
- Contracts owns `packages/contracts`, `packages/provider-spi`, and `packages/providers/fake` semantics.
- Durable control owns `packages/store`, `packages/core`, and resource routes under `apps/server/src/routes`.
- Web owns actual `apps/web` implementation and end-to-end UI flows.
- Coordinate root dependency and lockfile changes with foundation while branches are parallel. Rebase each child branch on its parent before creating a stacked PR. Set explicit PR base and head, and link dependencies.
- Do not merge PRs, deploy to production, or run paid provider operations without a separate user request.

## Mandatory PR review gate

Before creating **any** PR, including a draft, run an independent static code review using a subagent with model `gpt-6-luna` and `reasoning_effort: high`. Give the reviewer the spec, worktree paths, base ref and SHA, complete diff, validation results, and ask it to inspect the code independently. Review agents are read-only.

Address **every actionable finding**, regardless of severity, rerun relevant checks, and request another independent review of the complete resulting diff. Repeat until the final reviewer reports **zero remaining actionable findings**. Do not self-waive findings or create a PR if reviewer access or findings are unresolved. Any subsequent rebase, integration, or code change requires a fresh review of the changed result before PR creation.

Record each review round, reviewer model and effort, findings and fixes, test results, and final reviewed HEAD and base SHAs in a local review report. Summarize that provenance in the PR body. Commit and push are allowed before this gate; PR creation is not.
