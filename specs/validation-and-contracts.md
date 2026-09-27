# Validation and executable contracts

Current validation ownership · September 27, 2026

Use **Zod 4** as Sandbar's validation library. Keep one schema language across the TypeScript service, provider integration boundaries, and browser forms. Zod's native JSON Schema export supports the language-neutral contract workflow; Valibot remains a reasonable alternative, but using both adds unnecessary duplication. [Zod JSON Schema](https://zod.dev/json-schema)

## Schema ownership

The [direct TypeScript SDK](direct-typescript-sdk.md) reuses portable value/driver schemas while defining resource handles independently of service-only project and durable-operation envelopes. Validate both direct and HTTP IO boundaries; do not force in-process calls through JSON serialization solely for code reuse.

The SDK exposes portable sandbox and execution validation. Lower-level portable primitives live in `sandbar-adapter/portable` to keep provider, core and SDK dependencies acyclic. The standalone service owns HTTP request/response, authentication, project and stream-frame schemas in `apps/server/src/http-contracts.ts`; the UI reuses that service source. Service route metadata and those schemas generate the checked-in `apps/server/openapi.json`.

Generate internal TypeScript, Rust, and Python transport/models from the published protocol, with handwritten public SDK conveniences. Hono RPC types may help internal development but are not the public protocol or the only client contract. Keep client response decoders forward-compatible with additive fields, while server request schemas reject unknown fields that could hide a security-sensitive typo.

Wire values use explicit discriminated unions, RFC 3339 timestamp strings, decimal strings for money, and documented integer ranges. Avoid JavaScript Date, bigint, implicit coercion, and transforms in wire schemas. Conversion must fail on unrepresentable constraints rather than silently widening them; semantic checks that cannot be exported require prose and shared conformance fixtures. Convert wire values into domain values after parsing. URL query parsing has its own deliberate conversion rules.

## Boundaries

| Boundary | Required handling |
|---|---|
| HTTP input | Validate path/query/header/body fields; enforce content type, size and collection limits before expensive work; use consistent structured errors |
| HTTP output | Construct explicit public DTOs and validate before serialization; never return raw database/provider objects; redact validation diagnostics |
| UI input | Reuse applicable contract schemas for forms and validate Router search parameters; server independently validates and authorizes |
| Provider configuration and credentials | Each adapter owns its credential/config schemas and declares which values are secret; API and UI use safe field metadata |
| Provider responses | Decode unknown data inside the adapter; accept harmless additive native fields, validate all fields used for identity, policy, effects or accounting |
| Driver results | Validate normalized results at the driver-to-domain boundary, including operation tokens, capabilities and native scope |
| Webhooks | Verify signatures over original bounded bytes, then decode, validate and durably deduplicate |
| Durable work and persisted JSON | Include schema versions; validate on write and read; explicit upcasters/migrations; quarantine malformed work without redispatching uncertain effects |
| Streams and uploads | Validate control frames/envelopes and limits; stream binary data with byte limits, backpressure and integrity checks instead of buffering it into a JSON schema |
| Configuration, CLI and secret files | Parse once at startup or rotation; reject invalid combinations with diagnostics that omit values |
| Accounting imports/exports | Validate scope, units, decimal/currency representation, source revision and attribution before committing; validate public export envelopes |

Validation is separate from authorization, capability evaluation, transactional invariants, and database constraints. A syntactically valid network policy still needs verified enforcement. A provider SDK TypeScript type is not runtime validation. SQL foreign keys, unique constraints and transactional checks enforce concurrency-sensitive rules.

After an external mutation, an invalid provider result is an ambiguous effect, not a safe pre-submission failure. Preserve redacted evidence and reconcile; never replay create/exec because decoding failed. An invalid public response after admission also must not erase the committed operation or cause a fresh invocation on retry.

## Database schemas and verification

Drizzle schemas own persistence layout. Public Zod schemas own the public contract. Explicit mappers connect them; database-generated validators can help internal records but must not expose encrypted secrets, internal leases, native payloads or implementation columns. Verify any Drizzle/Zod integration against the exact beta package exports before adopting it: current documentation also describes later prereleases.

Validate each crossing of an IO/trust boundary; do not repeatedly parse the same already-validated value through every pure helper. Return stable error codes and safe field paths. Provider payloads, rejected secret values and command output must not appear in generic validation logs.

Contract CI should check OpenAPI generation without drift, request/response/frame fixtures, invalid inputs, additive response compatibility, migrations of durable payload versions, and generated transports in all three languages. Include secret-leak and malformed-provider-response cases alongside operation recovery tests.

Sources: [Hono validation](https://hono.dev/docs/guides/validation), [Zod JSON Schema](https://zod.dev/json-schema), [Drizzle validation integration](https://orm.drizzle.team/docs/zod).
