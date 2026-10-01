# FAKE SANDBOX PROVIDER — simulation only

This provider is a deterministic local HTTP simulation for Sandbar control-plane tests. It is **not a sandbox or isolation boundary**. It never runs host commands, builds images, contacts paid providers, or enforces a guest network policy. Command results come only from explicit test fixtures; file writes use an in-memory virtual filesystem persisted in the fake provider's state file.

The fake runs in an independent process. Its JSON state file holds native sandbox IDs, virtual files, effect/invocation ledger, and test scenarios. Keep that file when restarting Sandbar to test uncertain submission recovery. Start a separate fake process with a separate state path to test restarting the provider itself. Both the server bind and driver destination are restricted to loopback. The server requires a transport token and marks every response `X-Sandbar-Fake-Provider: simulation`.

## Run

```sh
SANDBAR_ENABLE_FAKE_PROVIDER=1 \
SANDBAR_FAKE_TEST_MODE=1 \
SANDBAR_FAKE_STATE_PATH=/tmp/sandbar-fake-provider.json \
SANDBAR_FAKE_TOKEN=local-test-token-12345 \
bun packages/providers/fake/src/cli.ts
```

Use a unique state path per test. The default port is 8789; `SANDBAR_FAKE_PORT` overrides it. The Sandbar driver is `new FakeProviderDriver({ baseUrl: "http://127.0.0.1:8789", token })`. A fake connection uses native scope `{ provider: "fake", connectionId, accountId: "fake-local", region: "local" }` and supports only the `fake-starter` prepared image with a `blocked` network selection. That is a declared simulation profile, not evidence that a real provider enforces blocked egress.

## Test controls

All control endpoints require the same Bearer token and exist only with `SANDBAR_FAKE_TEST_MODE=1`. They are never exposed by Sandbar's public API.

| Method/path | Purpose |
|---|---|
| `POST /_test/reset` | Clear all fake state; body `{}` |
| `POST /_test/seed` | Set one scenario by action and submission ID |
| `POST /_test/profile` | Set global native idempotency and submission discovery support |
| `POST /_test/events/seed` | Append an explicit ordered array of native events, including duplicates |
| `GET /_test/state` | Inspect native resources and the invocation/effect ledger |

Example scenario body:

```json
{
  "submissionId": "op_create_1",
  "action": "create",
  "behavior": "lost_after_effect",
  "delayObservations": 0
}
```

`action` is `create`, `exec`, `destroy`, or `file_write`. `behavior` is `normal`, `lost_after_effect`, `reject`, or `ambiguous_before_effect`. A lost response applies the effect and persists the ledger before returning HTTP 504. The driver normalizes that transport failure to `unknown`, and a later `observe` can recover the result if discovery is supported. `delayObservations` returns pending for that many observe calls before revealing the completed effect; it uses no wall-clock sleep. `reject` is definitive with no effect. `ambiguous_before_effect` returns unknown without ledger evidence, so absence from discovery cannot prove no effect.

For public API E2E flows where Sandbar allocates an opaque submission ID, seed `"submissionId": "*"`. Wildcard scenarios form a FIFO queue per action and are consumed atomically by the next matching mutation. Exact-ID scenarios take precedence. Seed before sending the public request; no polling or timing race is needed.

An exec scenario must include a matching `command` fixture such as:

```json
{
  "submissionId": "op_exec_1",
  "action": "exec",
  "behavior": "lost_after_effect",
  "command": {
    "command": { "kind": "argv", "argv": ["fixture", "hello"] },
    "exitCode": 7,
    "stdoutBase64": "Zml4dHVyZSBvdXRwdXQ=",
    "stderrBase64": ""
  }
}
```

No fixture means exec is definitively unsupported. A nonzero exit code is a completed execution, not a provider failure. A fixture matches `cwd` and `env` exactly: omitted `cwd` means no cwd, and omitted `env` means an empty environment. An optional `deadlineSeconds` constrains the requested deadline when present. Nonmatching values are rejected. Captured output is bounded to the requested byte count. File content is binary and limited to 1 MiB per file; all state is capped at 8 MiB, with at most 128 resources and 512 ledger entries. When the ledger or state file is full, new mutations receive a definitive capacity rejection with no persisted effect; existing matching submissions can still retrieve their prior result. The fake supports exact virtual file paths, not directories, symlinks, mount durability, or a real process deadline. File writes carry a stable invocation and can be observed after a lost response.

To test the unsafe retry case, set `POST /_test/profile` to:

```json
{
  "nativeIdempotency": { "create": false, "exec": false, "destroy": false },
  "discoveryBySubmission": false
}
```

A direct duplicate submission then creates another native resource or execution. When two effects share a submission ID, `observe` returns no unique result and reconciliation must inspect candidates. Sandbar must retain `unknown` and observe/inspect candidates without automatically resubmitting. Test state exposes the latest 512 received invocations and the bounded effect ledger so E2E assertions can count effects across a Sandbar restart. Ledger entries hold request fingerprints rather than raw command environment or file bytes; conflicting reuse of a submission ID is rejected, including reuse by another caller in the same native scope. Test-seeded event arrays preserve duplicates and out-of-order sequence values for inbox/reconciliation tests; the fake does not automatically deliver webhooks.

This simulation validates Sandbar's translation, scope validation, effect handling, and recovery wiring. It says nothing about Daytona, E2B, Modal, Tensorlake, native isolation, billing, or vendor conformance.
