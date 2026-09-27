---
title: Provider and runtime support
description: Measured support and planned integrations.
---

| Component                             | Status                                | Evidence                                                     |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| Independent fake provider             | Qualified for local simulation        | Direct and remote resource tests, package smoke              |
| Direct SDK on Bun 1.3.14              | Qualified with fake                   | macOS arm64 and Ubuntu CI                                    |
| Direct SDK on Node.js 22.23.2         | Qualified with fake                   | Ubuntu CI                                                    |
| Direct SDK on Node.js 26.4.0          | Qualified with fake                   | macOS arm64                                                  |
| Remote SDK                            | Exercised with local service and fake | SDK parity tests; packed remote HTTP resource flows untested |
| SQLite service store                  | Implemented and tested                | Store and service tests                                      |
| MySQL service store                   | Implemented, separately tested        | Requires test database for live run                          |
| Daytona, E2B, Modal, Tensorlake       | Planned                               | No adapters qualified                                        |
| Rust and Python remote SDKs           | Planned                               | No packages implemented                                      |
| Snapshots, storage mounts, accounting | Planned design                        | No public API implemented                                    |

The fake returns fixture output and maintains a virtual file system. It never executes host commands, builds images, enforces network isolation or calls a paid provider. A successful fake test does not establish real-provider behavior. [Runtime qualification](https://github.com/pandemicsyn/sandbar/blob/af06bb6/docs/sdk-runtime-qualification.md) records the measured package matrix.

Malformed successful fake inspect responses may currently surface a Zod validation error directly. This behavior does not qualify error handling for a real provider.
