---
title: Tested provider support
description: Functional test coverage for Daytona and E2B, with dated evidence and configuration limits.
---

**Daytona and E2B passed all 13 prepared-image baseline checks** against the merged SDK on September 28, 2026, with sandbox cleanup confirmed. Both are built into `sandbar-sdk`.

These are real provider runs through the public SDK, covering the configurations below. They establish a working baseline, not a guarantee for every image, region, network setting, or native feature.

## Functional test matrix

| Workflow                                | Daytona                                                        | E2B                                            |
| --------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Authenticate and connect                | Passed                                                         | Passed                                         |
| Create from a prepared image            | Passed                                                         | Passed                                         |
| Inspect and list scoped sandboxes       | Passed                                                         | Passed                                         |
| Run argv and shell commands             | Passed                                                         | Passed                                         |
| Handle nonzero exit and captured output | Passed                                                         | Passed                                         |
| Write and read binary files             | Passed                                                         | Passed                                         |
| Overwrite an existing file              | Passed in `/tmp`                                               | Passed in `/home/user`                         |
| Reject a no-clobber conflict            | Passed in `/tmp`                                               | Passed in `/home/user`                         |
| Destroy and confirm cleanup             | Passed                                                         | Passed                                         |
| Close the client                        | Passed                                                         | Passed                                         |
| Build from an OCI image                 | Implemented; not live-tested                                   | Implemented; not live-tested                   |
| Measure network isolation               | Not tested                                                     | Not tested                                     |
| Capture and restore snapshots           | Container stop/capture/restart, fresh execution; fixtures only | Filesystem + RAM capture; restore unsupported  |
| Volumes and create-time mounts          | Writable/subpaths; not live-qualified                          | Private-beta artifact CRUD; mounts unsupported |

“Passed” means that workflow completed in the recorded live run and the run confirmed cleanup. “Implemented; not live-tested” means code and offline tests exist, but this evidence does not establish real-provider behavior.

## Tested configurations

| Setting                  | Daytona                                 | E2B                          |
| ------------------------ | --------------------------------------- | ---------------------------- |
| SDK revision             | `3be54464` · version `0.0.0`            | `3be54464` · version `0.0.0` |
| Runtime                  | Bun 1.3.14, macOS arm64                 | Bun 1.3.14, macOS arm64      |
| Image                    | Borrowed `daytona-small` Linux snapshot | Public `base` template       |
| Region                   | `us`                                    | Provider default             |
| Authority                | Verified organization                   | Authenticated API key        |
| Requested network policy | `daytona-default`                       | `blocked`                    |
| File workspace           | `/tmp`                                  | `/home/user`                 |
| Native lifetime limit    | 15 minutes                              | 5 minutes                    |
| Native interface         | Daytona REST 0.218                      | `e2b` 2.51.0                 |

See [Daytona setup](/docs/providers/daytona/) or [E2B setup](/docs/providers/e2b/) to use these workflows. The [live test evidence](/docs/providers/live-qualification/) records individual scenarios, exact SDK and harness revisions, dated results, and source evidence. Prior configurations remain visible where relevant.

## Limits of these results

- **Networking:** neither baseline probes egress. Daytona's `daytona-default` permits essential services; E2B's requested `blocked` setting is not itself an observed isolation result.
- **Files:** an earlier E2B overwrite directly in sticky `/tmp` failed. The `/home/user` pass does not supersede that limitation or qualify arbitrary paths and users. Custom images need the documented utilities and filesystem behavior.
- **Images:** prepared-image creation does not qualify OCI builds, retained-image cleanup, or snapshot capture/restore. Builds require their own resource budget and evidence.
- **Scope:** other regions, templates, account policies, and runtimes were not exercised by these live baselines.

## Other integrations

| Integration      | Distribution                                  | Evidence                                                                               |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Modal            | Separate experimental `sandbar-modal` package | Deterministic native-boundary and packed consumer tests; no live qualification.        |
| Custom providers | Separately installed adapter package          | Defined by its author; use the [adapter test kit](/docs/guides/adapter-capabilities/). |
| Fake provider    | Internal development fixture                  | Simulation only; does not execute commands or provide isolation.                       |

Modal is not a built-in SDK subpath. Add another provider through the [public adapter API](/docs/guides/write-an-adapter/).

## Runtimes

The SDK targets server-side Node.js and Bun. Packed consumer checks exercise the emitted JavaScript and strict TypeScript declarations on Node.js 26.4.0 and Bun 1.3.14 on macOS arm64. CI also runs Node 22 and Bun 1.3.14 on Linux. These package checks use deterministic fixtures; the live results above use Bun on macOS.

## Keeping the matrix current

Live qualification is manual and uses finite resource budgets and owned-sandbox cleanup. Reviewed results live in one JSON file per provider; the detailed evidence page is generated from those files. Update this summary when accepted evidence changes. Ordinary docs builds remain offline.
