---
title: Choose a mode
description: Compare Sandbar's direct and service-backed TypeScript entry points.
---

|                      | Direct                                            | Service-backed                        |
| -------------------- | ------------------------------------------------- | ------------------------------------- |
| Entry point          | `sandbar-sdk`                                     | `sandbar-service/client`              |
| Runs in              | Server-side Node.js or Bun process                | Client talks to your Bun/Hono service |
| Provider credentials | Caller process                                    | Service operator                      |
| Control database     | None                                              | SQLite or MySQL                       |
| Operation durability | Process, with provider observation when available | Service admission and reconciliation  |
| Management UI        | None                                              | Vite UI served by service             |

Both expose `sandboxes.create`, `inspect`, `exec`, binary file transfer and `destroy`. Both can return an uncertain outcome if completion cannot be proven. Direct mode can integrate its own durable ledger through the optional SDK operation lifecycle; ordinary calls still require saving recovery references. The service gives a durable admission path; it still cannot invent missing provider evidence. See [Recovery](/docs/guides/recovery/).
