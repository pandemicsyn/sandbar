# Specifications and design decisions

Public usage documentation lives in [apps/docs](../apps/docs/README.md). Implementation sequencing lives in [plans](../plans/implementation-plan.md).

## Accepted implementation decisions

- [Public packages and adapter conventions](package-conventions.md) — selected names, built-in providers, custom integrations and release boundaries.
- [First-class custom adapter DX](custom-adapters.md) — approved SDK-first refactor; implementation and qualification in progress.

## Implemented interfaces and architecture

- [Public API contract and executable schema sources](api-spec.md)
- [Architecture and selected stack](design.md)
- [Direct and remote TypeScript SDK constraints](direct-typescript-sdk.md)
- [Measured runtime and package qualification](sdk-runtime-qualification.md)
- [Validation boundaries](validation-and-contracts.md)

## Design requirements and future proposals

These documents mix accepted behavioral requirements with resource/features beyond the implemented initial slice. They are design context, not support matrices or runnable SDK examples. Current schemas, package READMEs and tested public docs describe available behavior.

- [Contract recommendations and review decisions](contract-recommendations.md)
- [Storage, snapshots and images](storage-and-images.md)
- [Observability, usage and accounting](observability-and-accounting.md)
- [Management UI scope](management-ui.md)
- [Provider research and design targets](provider-drivers.md)
- [First-class custom adapter DX](custom-adapters.md) — approved implementation direction, not implemented; permits changes to the unpublished SPI and service integration.

## Historical material

[Archived drafts](archive/README.md) preserve superseded architectures, API sketches and the completed SDK implementation sequence. They are not current implementation instructions. [Archived plans](../plans/archive/README.md) preserve the original roadmap and task handoffs.
