---
title: Self-hosting the service
description: Source setup, storage and operator considerations for the development service.
---

The self-hosted service runs on Bun with Hono. It uses Drizzle with SQLite by default and a separately tested MySQL backend. The Vite management UI is served by the service after its assets are built. It is a separate application from this static documentation site.

For a local development instance, build from source with `bun install --frozen-lockfile`, `bun run build:packages`, and `bun run build`. Configure `SANDBAR_DB_URL`, `SANDBAR_KEY_FILE` and `SANDBAR_SETUP_TOKEN_FILE` before starting `bun run start`. The key file must contain 32 random bytes and the setup token should be stored in a mode-0600 file. The checked-in [process fixture](https://github.com/pandemicsyn/sandbar/blob/c4dea72/packages/sdk-qualification/processes.ts) demonstrates isolated local setup. The fake provider needs its own loopback URL, token and state path.

The setup flow creates an operator session, then a project and provider connection. Keep service credentials, encryption keys, setup tokens and provider tokens out of this docs build and any browser bundle. Use HTTPS for non-loopback remote SDK traffic. The public HTTP routes are in the [generated API reference](/docs/reference/http/).

This development build has no published container or managed deployment recipe. Back up the database, keys and fake state separately during evaluation. Read [the implementation plan](https://github.com/pandemicsyn/sandbar/blob/c4dea72/docs/implementation-plan.md) as engineering context; proposed operations there are not a production guarantee.
