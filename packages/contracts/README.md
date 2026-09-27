# Initial wire contracts

`src/index.ts` defines Zod 4 request, response, error, binary receipt, and output-frame schemas for the first fake-provider control slice. Request bodies reject unknown fields; response decoders tolerate additive fields. The schemas are public DTOs and do not expose native provider references or database rows.

`openapi.json` is emitted from the schemas and route metadata in `src/openapi.ts`. Regenerate with `bun run --cwd packages/contracts openapi:generate`; `bun run check` fails on drift. Streaming frames remain an explicit Zod union, while file endpoints use bounded `application/octet-stream` bytes rather than JSON base64 on the public API.

`canonicalJson` and `intentSha256` operate on normalized caller intent before defaults are applied. Callers must first validate with the matching request schema. A repeated Idempotency-Key is looked up project-and-endpoint scoped before resolving current defaults; the service owns age validation and durable records. These helpers do not hash effective plans. The server computes the hash from parsed JSON values using JavaScript key sorting and `JSON.stringify`; clients supply the same request and Idempotency-Key and do not compute this hash. This helper is internal to the Bun/JavaScript control implementation, not a cross-language canonical JSON wire format.

This is an initial executable subset. The broader image, policy, storage, accounting, and optional stream contracts in the design documents remain future work. The fake provider supports only `fake-starter` and `blocked` as a simulation profile.
