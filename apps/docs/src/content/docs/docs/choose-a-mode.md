---
title: Choose a mode
description: Compare Sandbar's direct and service-backed TypeScript entry points.
---

|                      | Direct                                            | Service-backed                        |
| -------------------- | ------------------------------------------------- | ------------------------------------- |
| Entry point          | `@sandbar/sdk/direct`                             | `@sandbar/sdk/remote`                 |
| Runs in              | Server-side Node.js or Bun process                | Client talks to your Bun/Hono service |
| Provider credentials | Caller process                                    | Service operator                      |
| Control database     | None                                              | SQLite or MySQL                       |
| Operation durability | Process, with provider observation when available | Service admission and reconciliation  |
| Management UI        | None                                              | Vite UI served by service             |

Both expose `sandboxes.create`, `inspect`, `exec`, binary file transfer and `destroy`. Both can return an uncertain outcome if completion cannot be proven. Direct mode cannot guarantee crash recovery between provider submission and saving a reference. The service gives a durable admission path; it still cannot invent missing provider evidence. See [Recovery](/docs/guides/recovery/).
