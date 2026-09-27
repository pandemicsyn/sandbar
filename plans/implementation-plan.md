# Implementation plan

Updated September 27, 2026. This records current sequencing, not publication or deployment status.

## Completed

PRs #1–#8 merged the fake-provider service and management UI, portable core, direct/remote TypeScript SDK, packed Node/Bun qualification, and Astro/Starlight documentation source. See [runtime qualification](../specs/sdk-runtime-qualification.md) for the measured support and limits. The docs site is not deployed and packages are not published.

## Current work

- Finish the reviewed Daytona implementation and shared provider registration, then integrate Modal on its final merged parent. Both need direct and service fixtures, packed runtime checks, independent review, CI and completed GitHub feedback review. Live/paid provider conformance has not been run.
- Keep Effect research isolated and experimental. Its prototype and measurements support an adoption recommendation; they do not authorize migration or merging the experiment into production.
- Keep public documentation in `apps/docs`, design requirements and proposals in `specs`, and implementation sequencing here. Completed plans and superseded designs belong in the archive.

## Future proposals

Named environments, broader image preparation, storage/checkpoints, streaming, accounting, Rust/Python SDKs and additional providers remain design targets. They are not implied by the completed initial slice. The [archived initial plan](archive/implementation-plan-2026-09-26.md) preserves those phase proposals and original acceptance criteria without making its old task order current.

See the [specification index](../specs/README.md) for the corresponding design documents. Publication, deployment, domain/resource changes and paid provider operations require separate authorization.
