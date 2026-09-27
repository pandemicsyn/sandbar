# Public API contract

The implemented HTTP contract is defined by [Zod schemas](../apps/server/src/http-contracts.ts) and the [OpenAPI generator](../apps/server/src/openapi.ts). The checked-in [OpenAPI document](../apps/server/openapi.json) and [generated HTTP reference](../apps/docs/src/content/docs/docs/reference/http.md) describe the current routes. Do not treat proposed routes in older prose as implemented endpoints.

The earlier [draft API overview](archive/api-spec-v0.3.md) is archived. [Contract recommendations](contract-recommendations.md), [storage and images](storage-and-images.md), and [observability and accounting](observability-and-accounting.md) retain design requirements and future proposals; they do not replace executable schemas for currently supported requests.

See [the TypeScript SDK](../packages/sdk/README.md) for resource handles and direct and service-client semantics. A direct operation is not a service-durable HTTP admission, and no recovery reference authorizes replay of an uncertain mutation.
