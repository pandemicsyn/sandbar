---
title: TypeScript reference
description: SDK connections, images, resource handles, operations, and errors.
---

Import `Sandbar` and `Image` from `sandbar-sdk`. The built-in provider factories are `daytona` from `sandbar-sdk/daytona` and `e2b` from `sandbar-sdk/e2b`. See the [generated export index](/docs/reference/generated-typescript/) for public names.

## Connect

```ts
const sandbar = await Sandbar.connect(e2b({ apiKey }));
```

Factories package typed settings without provider IO. `Sandbar.connect` validates the settings, verifies the native connection, and owns the session. Use the SDK in a server-side Node.js or Bun process.

For a separately installed adapter:

```ts
const sandbar = await Sandbar.connect({
  adapter: acme,
  config: { region: "us" },
  credentials: { token },
  onReference: async (reference) => {
    await persistReference(reference);
  },
});
```

`acme` is the installed adapter definition; `persistReference` is your application's persistence function. Config and credentials follow the adapter's schemas. The optional `onReference` callback checkpoints the initial operation reference before provider dispatch. It is not called when recovery tokens change. After each pending `observe()` result, persist the handle's updated `reference` yourself. See [Errors and recovery](/docs/guides/recovery/#persist-references-when-it-matters) and the [tested custom adapter example](/docs/guides/write-an-adapter/).

## Images

| API                                             | Behavior                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `Image.prepared(value)`                         | Select an existing image ID/name or scoped `PreparedImage` result.          |
| `Image.oci(reference)`                          | Describe an OCI source supported by the adapter.                            |
| `sandbar.images.build({ source }, { signal? })` | Build and wait for a scoped prepared image plus retained-resource metadata. |
| `sandbar.images.submitBuild(input, options?)`   | Submit a build and return an operation handle.                              |

Build results contain `prepared` and `retainedResources`. A prepared handle is bound to its verified provider scope. Destroying a sandbox does not delete a built image. See [Images and networking](/docs/guides/images-and-networking/).

## Sandboxes

| API                                                                                        | Behavior                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `sandbar.sandboxes.create({ environment, networkPolicy?, region?, labels? }, { signal? })` | Submit creation and wait for a sandbox handle.        |
| `sandbar.sandboxes.submitCreate(input, options?)`                                          | Submit creation and return an operation handle.       |
| `box.id`                                                                                   | Sandbox identifier.                                   |
| `box.inspect()`                                                                            | Read current state where supported.                   |
| `box.exec(input, { signal? })`                                                             | Run a command and return bounded binary output.       |
| `box.submitExec(input, options?)`                                                          | Submit execution and return an operation handle.      |
| `box.readFile(path)`                                                                       | Read up to 1 MiB as a `Uint8Array`.                   |
| `box.writeFile(path, bytes, { overwrite?, signal? })`                                      | Write up to 1 MiB; overwrite defaults to false.       |
| `box.destroy({ signal? })`                                                                 | Wait for confirmed compute termination.               |
| `sandbar.close()`                                                                          | Release client resources; does not destroy sandboxes. |

Optional operations fail locally when the adapter does not implement them.

## Execution input and output

`exec` and `submitExec` accept `readonly string[]` or an `ExecInput` object. An array is shorthand for `{ command: { kind: "argv", argv } }`. Each element is literal, the array is copied before dispatch, and an empty array is invalid.

Use the object form for `cwd`, `env`, `deadlineSeconds`, `maxOutputBytes`, or `{ command: { kind: "shell", script } }`. The default deadline is 300 seconds and the default output limit is 1 MiB combined across stdout and stderr.

`ExecOutput` contains `stdout` and `stderr` byte arrays, `exitCode`, `truncated`, and `stdoutText(maxBytes?)` / `stderrText(maxBytes?)` helpers. Text helpers default to 16 KiB. See [Files and output](/docs/guides/files-and-output/).

## Operations and recovery

An SDK operation exposes `reference`, `durability: "process"`, `observe()`, and `wait({ signal?, pollMs? })`. Observation returns `null` while completion is unknown. Poll intervals are between 50 and 60,000 milliseconds; adapter delays can set a later earliest poll.

`sandbar.recover(reference)` imports a saved reference in the same verified scope and returns an operation handle. It only observes; it never resubmits. Aborting a wait stops local waiting, not provider compute.

`SandbarError` exposes `code` and `effect`. `OutcomeUnknownError` and `WaitAbortedError` carry recovery references. `NonzeroExitError` carries a completed command's output; `NoExitCodeError` means its exit code is unconfirmed. See [Errors and recovery](/docs/guides/recovery/).

## Advanced lifecycle

`sandbar.operations.inventory({ limit, cursor? })` reads scoped inventory where supported. `operations.prepare(kind, input)` returns a single-use prepared attempt; its `submit(identity, { beforeSubmit })` hook lets an application commit a durable submission marker before native IO. Returning false or throwing in the hook prevents dispatch.

Persist accepted pending tokens with their versions. `operations.observe(...)` reads prior evidence without preparing or submitting again. These lower-level calls use adapter input shapes and require application-owned persistence. See [Asynchronous adapter recovery](/docs/guides/adapter-recovery/).

## Adapter authoring

`sandbar-adapter` exports `defineAdapter`, `AdapterError`, operation result helpers, and scoped operation types. `sandbar-adapter/testing` exports `adapterSuite`. An adapter with no host policy does not expose `withPolicy`; policy-bearing definitions validate and clone host policy synchronously. Start with [Write an adapter](/docs/guides/write-an-adapter/).
