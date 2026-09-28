# sandbar-service

The optional self-hosted Sandbar management service. It consumes the public `sandbar-sdk` and `sandbar-adapter` packages, provides durable operation tracking, authentication, and the management UI, and runs on Bun. Install with `npm install sandbar-service`.

Remote consumers import `Sandbar` from `sandbar-service/client`; that client runs on Node.js or Bun without hosting the service. See the [service quickstart](../../apps/docs/internal/service-quickstart.md) and [self-hosting guide](../../apps/docs/internal/self-hosting/create-service.md).
