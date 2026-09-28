---
title: Self-hosting the service
description: Source setup, storage and operator considerations for the development service.
---

The self-hosted service runs on Bun with Hono. It uses Drizzle with SQLite by default and a separately tested MySQL backend. The Vite management UI is served by the service after its assets are built. It is a separate application from this static documentation site.

For a local development instance, run these commands from the repository root in one shell. They create private temporary credentials and start the independent fake provider before the service:

```sh
bun install --frozen-lockfile
bun run build:packages
bun run build

export SANDBAR_DEV_DIR="$(mktemp -d)"
chmod 700 "$SANDBAR_DEV_DIR"
openssl rand -out "$SANDBAR_DEV_DIR/key" 32
openssl rand -hex 24 > "$SANDBAR_DEV_DIR/setup-token"
chmod 600 "$SANDBAR_DEV_DIR/key" "$SANDBAR_DEV_DIR/setup-token"

export SANDBAR_ENABLE_FAKE_PROVIDER=1
export SANDBAR_FAKE_STATE_PATH="$SANDBAR_DEV_DIR/fake.json"
export SANDBAR_FAKE_TOKEN="$(openssl rand -hex 24)"
bun packages/providers/fake/src/cli.ts &
export SANDBAR_FAKE_PID=$!

export SANDBAR_DB_URL="$SANDBAR_DEV_DIR/control.sqlite"
export SANDBAR_KEY_FILE="$SANDBAR_DEV_DIR/key"
export SANDBAR_SETUP_TOKEN_FILE="$SANDBAR_DEV_DIR/setup-token"
export SANDBAR_FAKE_PROVIDER_URL="http://127.0.0.1:8789"
export SANDBAR_FAKE_PROVIDER_TOKEN="$SANDBAR_FAKE_TOKEN"
bun run start
```

The fake provider listens on loopback port 8789 by default; the service listens on loopback port 3000 by default. The service and fake process must share the same fake transport token. After stopping the service with Ctrl-C, run `kill "$SANDBAR_FAKE_PID"` to stop the fake process. The temporary directory holds the SQLite database, encryption key, setup token and fake state; keep it if you need to inspect or restart this local instance, or remove it when finished. The checked-in [process fixture](https://github.com/pandemicsyn/sandbar/blob/af06bb6/packages/sdk-qualification/processes.ts) demonstrates isolated local setup. The fake provider is a development simulation, not an isolated sandbox or real provider.

The setup flow creates an operator session, then a project and provider connection. Keep service credentials, encryption keys, setup tokens and provider tokens out of this docs build and any browser bundle. Use HTTPS for non-loopback remote SDK traffic. The public HTTP routes are in the [generated API reference](../reference/http.md).

This development build has no published container or managed deployment recipe. Back up the database, keys and fake state separately during evaluation. Read [the implementation plan](https://github.com/pandemicsyn/sandbar/blob/af06bb6/docs/implementation-plan.md) as engineering context; proposed operations there are not a production guarantee.
