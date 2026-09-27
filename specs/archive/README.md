# Original design sketches

These files preserve the initial SDK-first design before the Worker/celld and SQLite-backed Durable Object decisions:

- [Original design](sandbar-design-v0.1.md)
- [Original TypeScript declarations](sandbar-api-v0.1.ts)

They are historical reference, not the current public contract. The original TypeScript file contains declarations only and is not an implemented package or generated wire schema. The current documents take precedence.

Important changes since these sketches:

- A durable self-hosted Hono service is the selected architecture; earlier Worker designs are retained below.
- TypeScript is implemented; Rust and Python remain remote SDK design targets.
- Shared SQLite/MySQL tables own state and fleet queries; the earlier per-DO databases are superseded.
- Persistent storage and optional workspace versioning are separate drivers.
- Network policy and credential binding require richer semantics than the original simplified fields.
- Images, pools, inventory, endpoints, tunnels, provider events, and optional telemetry are explicit integration surfaces.

Relative links have been adjusted for the repository reorganization. Historical terminology and proposal content remain; consult the current specification index for implemented behavior.

## Architecture draft before the expanded strategy review

The September 26 v0.2 drafts are also preserved:

- [Worker/DO architecture baseline](sandbar-design-v0.2.md)
- [API overview](sandbar-api-spec-v0.2.md)
- [Implementation plan](sandbar-plan-v0.2.md)

The runtime choice was reopened after these drafts. The strategy review itself deferred the choice; the subsequent decision selected Hono, Drizzle and relational storage.

- [v0.3 Worker baseline before relational selection](sandbar-design-v0.3.md)

The current [architecture](../design.md) and [implementation plan](../../plans/implementation-plan.md) govern implementation.

## Superseded September 27, 2026

- [Architecture draft 0.4](design-v0.4.md): retained before correcting its implementation-pending status.
- [API draft 0.3](api-spec-v0.3.md): superseded for implemented endpoints by executable contracts and generated OpenAPI.
- [SDK implementation wave 2](direct-typescript-sdk-wave-2.md): completed PR sequence, retained as historical design context.

Use the [current specification index](../README.md) and [current plan](../../plans/implementation-plan.md). Archived proposal examples are not supported API documentation.
