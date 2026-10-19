---
name: sandbar
description: Build application code that creates and drives cloud sandboxes with the Sandbar TypeScript SDK (sandbar-sdk) on Daytona, E2B, boxd, Boat, Runloop or Vercel. Use when writing or changing code that imports sandbar-sdk or an @sandbar-sdk/<provider> adapter, or when asked to run untrusted or generated code in a sandbox from a Node.js or Bun service.
---

# Build with the Sandbar SDK

Sandbar is one TypeScript API over several sandbox providers. The application talks to `sandbar-sdk`; a separately installed adapter (`@sandbar-sdk/<provider>`) handles the provider. Switching providers should only change adapter setup.

## Before writing code

1. Check installed versions (`package.json`, lockfile). Install `sandbar-sdk` and one adapter at `0.1.0` or later. The npm package named `sandbar` is unrelated; never install it.
2. Pick the provider the user named, then read its setup page: https://sandbarsdk.dev/docs/providers/support/
3. The SDK runs server-side only (Node.js or Bun). Read credentials from environment variables; never hard-code, log or send them to a browser.

## Connect

| Provider               | Package                | Connect with                                                                                                                |
| ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| E2B                    | `@sandbar-sdk/e2b`     | `Sandbar.connect(e2b({ apiKey }))`                                                                                          |
| Daytona                | `@sandbar-sdk/daytona` | `Sandbar.connect(daytona({ apiKey, target: "us", environment: Image.prepared("<snapshot>"), network: "daytona-default" }))` |
| boxd                   | `@sandbar-sdk/boxd`    | `Sandbar.connect({ adapter: boxdAdapter, credentials: { apiKey }, config: { org, network: "internet" } })`                  |
| Boat                   | `@sandbar-sdk/boat`    | `Sandbar.connect({ adapter: boatAdapter, credentials: { apiKey }, config: { network: "internet" } })`                       |
| Runloop (experimental) | `@sandbar-sdk/runloop` | `Sandbar.connect({ adapter: runloopAdapter, credentials: { apiKey }, config: { network: "blocked" } })`                     |
| Vercel                 | `@sandbar-sdk/vercel`  | `Sandbar.connect({ adapter: vercel, credentials: { token }, config: { teamId, projectId } })`                               |

`connect` verifies credentials with read-only calls and allocates nothing. Put provider choices (region, network policy, defaults) in this setup, not in every call.

## The default shape

Use `sandboxes.with()` when a sandbox is needed only for one task. It creates, runs the callback, and destroys, even on errors:

```ts
import { Sandbar } from "sandbar-sdk";
import { e2b } from "@sandbar-sdk/e2b";

const sandbar = await Sandbar.connect(e2b({ apiKey: process.env.E2B_API_KEY! }));

try {
  const text = await sandbar.sandboxes.with({}, async (box) => {
    await box.writeFile("/home/user/main.py", new TextEncoder().encode("print(2 + 2)\n"));
    return (await box.exec(["python3", "/home/user/main.py"])).stdoutText();
  });
  console.log(text);
} finally {
  await sandbar.close();
}
```

When the sandbox must outlive one call, use `create()` and `destroy()` yourself:

```ts
import { Image } from "sandbar-sdk";

const box = await sandbar.sandboxes.create({ environment: Image.prepared("base") }); // an E2B template
try {
  // work
} finally {
  await box.destroy();
}
```

`close()` never destroys a sandbox, and aborting a wait never stops remote compute. Always destroy what you created, inside `finally`, and close the client in an outer `finally`.

## Commands

- `box.exec(["git", "status"])` passes each array element literally; no shell runs.
- Use a shell only when you need pipes or redirection: `box.exec({ command: { kind: "shell", script: "make test 2>&1 | tail -n 50" } })`.
- The object form also takes `cwd`, `env`, `stdin`, `deadlineSeconds` and `maxOutputBytes`.
- A nonzero exit throws `NonzeroExitError`; read `error.result.exitCode` and `error.result.stderrText()`. The command did run.
- `NoExitCodeError` means it finished without a confirmed exit code. Do not treat that as success.
- Output is bytes. Use `stdoutText()` / `stderrText()` to decode, and check `result.truncated` before parsing.

## Files

`writeFile(path, bytes)` and `readFile(path)` use absolute paths and default to a 1 MiB limit (`maxBytes` up to 16 MiB). Writes refuse to replace an existing file unless you pass `{ overwrite: true }`; boxd, Vercel and Daytona mounted volumes always need `overwrite: true`. For larger files use `readFileStream` / `writeFileStream` where the adapter supports them. On E2B, work under `/home/user`.

## Errors and uncertain outcomes

Every failure is a `SandbarError` with `code` and `effect`. The rule that matters most:

- **`effect: "none"`**: nothing happened. Safe to fix and retry.
- **Anything else** (effect `possible`, `unknown`, `partial` or `applied`): the work may have happened. **Never blindly retry a create or exec.**
  - `OutcomeUnknownError` and `WaitAbortedError` carry the operation's `reference`. Save it and pass it to `client.recover(reference)`; that only observes the original request and never resubmits it.
  - `error.outcome` keeps whatever was confirmed, such as a sandbox reference (`outcome.sandbox`) or a partial snapshot. Keep it instead of redoing the work.

`with()` throws `SandboxCleanupError` when destroy fails; it carries `callbackOutcome`, `cleanupError` and `sandboxReference`. Report the reference so the sandbox can be cleaned up later.

## Keeping a sandbox across processes

Save `box.reference` (JSON, contains no credentials) in your own storage, then reopen with a fresh connection configured for the same provider and scope:

```ts
const reference = box.reference ?? (await box.inspect()).reference;
if (!reference) throw new Error("Sandbox identity is not available");
await save(JSON.stringify(reference));
// later, in another process
const reopened = await freshClient.sandboxes.get(JSON.parse(await load()));
```

Never build a reference by hand from a sandbox id. `get()` never creates or resumes anything.

## Provider differences to respect

- **Daytona:** set the network policy at connection (`"daytona-default"`, or `"internet"` on higher tiers). Omitting it means strict `blocked`, which may be unavailable. Create from an active snapshot in the chosen region.
- **E2B:** the `base` template works out of the box; use `/home/user`.
- **boxd:** needs `network: "internet"` and an org; files are capped at 1 MiB and need `overwrite: true`.
- **Boat:** needs `network: "internet"`; files live under `/home/user` or `/tmp`, are capped at 5 MiB and need `overwrite: true`. Sandboxes get none of the Boat account's secrets unless `environment` names one. `suspend()` archives the disk; `resume()` starts a fresh machine.
- **Runloop (experimental; sign-ups are invite-only):** egress is blocked by default (the adapter manages a deny-all `sandbar-blocked` network policy); pass `network: "internet"` to allow it. Files need `overwrite: true`. `suspend()` keeps the disk only; `snapshot()` captures the disk, and restores start fresh processes. `preview(port)` returns a URL plus an auth header unless `preview.access` is `"public"`.
- **Vercel:** disposable Node 24 sandboxes with blocked networking by default; no stdin, process streams, snapshots or volumes; files need `overwrite: true`.

Check `await client.sandboxes.checkCreate(input)` before an unusual create; it is read-only and reports `supported`, `unsupported`, `unavailable` or `unknown`.

## Testing and cost

Write tests against deterministic fixtures, not live providers. Live sandboxes cost money: get the user's approval for the exact resources and cleanup plan before creating any, and never leave sandboxes running.

## Read more

- Getting started: https://sandbarsdk.dev/docs/direct-quickstart/
- Sandboxes and execution: https://sandbarsdk.dev/docs/guides/resources/
- Errors and recovery: https://sandbarsdk.dev/docs/guides/recovery/
- Files and output: https://sandbarsdk.dev/docs/guides/files-and-output/
- TypeScript reference: https://sandbarsdk.dev/docs/reference/typescript/
- Troubleshooting: https://sandbarsdk.dev/docs/guides/troubleshooting/
