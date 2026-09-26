# Original design sketches

These files preserve the initial SDK-first design exactly as it existed before the Worker/celld and SQLite-backed Durable Object decisions:

- [Original design](sandbar-design-v0.1.md)
- [Original TypeScript declarations](sandbar-api-v0.1.ts)

They are historical reference, not the current public contract. The original TypeScript file contains declarations only and is not an implemented package or generated wire schema. The current documents take precedence.

Important changes since these sketches:

- A durable self-hosted Hono service is the selected architecture; earlier Worker designs are retained below.
- TypeScript, Rust, and Python are first-class SDKs over a shared protocol.
- Shared SQLite/MySQL tables own state and fleet queries; the earlier per-DO databases are superseded.
- Persistent storage and optional workspace versioning are separate drivers.
- Network policy and credential binding require richer semantics than the original simplified fields.
- Images, pools, inventory, endpoints, tunnels, provider events, and optional telemetry are explicit integration surfaces.

Some relative links and terminology inside the originals refer to their original filenames and layout. Consult this index and the current documents when following them.

## Architecture draft before the expanded strategy review

The September 26 v0.2 drafts are also preserved:

- [Worker/DO architecture baseline](sandbar-design-v0.2.md)
- [API overview](sandbar-api-spec-v0.2.md)
- [Implementation plan](sandbar-plan-v0.2.md)

The runtime choice was reopened after these drafts. The strategy review itself deferred the choice; the subsequent decision selected Hono, Drizzle and relational storage.

- [v0.3 Worker baseline before relational selection](sandbar-design-v0.3.md)

The current [architecture](../design.md) and [implementation plan](../implementation-plan.md) govern implementation.
