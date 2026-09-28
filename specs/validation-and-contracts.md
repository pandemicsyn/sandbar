# Validation and executable contracts

Current boundary requirements · September 28, 2026

Use Zod 4 for runtime contracts. TypeScript types do not validate provider data or public requests. Validate each IO/trust boundary once; pure helpers do not need to reparse already validated values.

## Ownership

- [sandbar-adapter](../packages/adapter/src/index.ts) owns adapter definitions, scope, native-operation outcomes and their validation. Its [portable schemas](../packages/adapter/src/portable.ts) are shared without depending on the service.
- The [SDK resource layer](../packages/sdk/src/resource.ts) owns consumer input normalization, handles and public errors. Direct calls do not pass through HTTP serialization for code reuse.
- The service owns [HTTP schemas](../apps/server/src/http-contracts.ts), [route/OpenAPI metadata](../apps/server/src/openapi.ts) and the generated [OpenAPI document](../apps/server/openapi.json). The UI composes applicable service schemas.
- Each provider adapter validates native responses and its own configuration/credentials. Native SDK types alone are insufficient.
- Drizzle [dialect schemas](../packages/store/src/schema/sqlite.ts) and migrations own persistence layout. Explicit mappings keep database rows and secrets out of public DTOs.

## Rules

| Boundary | Requirement |
| --- | --- |
| Consumer and HTTP inputs | Validate discriminated inputs, byte/collection limits and fields before mutation; reject unknown security-sensitive request fields |
| HTTP outputs | Construct and validate public DTOs; never serialize raw database/provider objects or credential values |
| Provider responses | Accept harmless additive fields, but validate identity, scope, policy, completion and effect evidence |
| Adapter results | Validate result shape, operation correlation and bounded/versioned recovery tokens |
| Persisted work | Validate versions and recovery data; malformed work cannot authorize redispatch |
| Binary files/output | Preserve bytes and enforce bounds; text helpers are explicit decoding operations |
| Configuration and secret files | Reject invalid combinations with diagnostics that omit secret values |

Validation is separate from authorization, capability checks and transaction invariants. A syntactically valid network policy still needs verified enforcement. References are locators, not credentials or deletion authority.

A malformed result after native mutation is an ambiguous effect. Retain the recovery reference and sanitized evidence; decoding failure must not cause mutation replay. After durable admission, an invalid HTTP response does not erase the admitted operation.

Wire schemas use JSON-compatible values and documented integer ranges; timestamps are strings and binary envelopes explicitly encode bytes. Keep client decoders tolerant of harmless additive response fields. Do not widen constraints silently when producing JSON Schema or OpenAPI. Redact rejected values, command output and native exception bodies from generic diagnostics.

## Verification

Contract checks cover schema/OpenAPI drift, invalid inputs, safe diagnostics, malformed native results, binary fidelity, persisted recovery and direct/service parity. See [qualification](../packages/sdk-qualification/README.md) for entrypoints. New features add boundary fixtures when implemented; this document does not require clients, webhooks or accounting subsystems that do not exist.
