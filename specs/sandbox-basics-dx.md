# Default creation and everyday files

Implementation contract · Creation defaults (#58), text helpers (#61) and directory APIs (#59) merged · October 2, 2026

The [filesystem contract](filesystem-dx.md) owns current directory, metadata, transfer and traversal guarantees. Exact signatures are owned by the [SDK exports](../packages/sdk/src/index.ts) and [public reference](../apps/docs/src/content/docs/docs/reference/typescript.md).

Configure a provider once, create a sandbox, write input, execute, read output and clean up. Creation defaults and UTF-8 helpers are implemented; current directory support supersedes the original restricted native mappings. Keep resource references, scope checks and [ordinary recovery semantics](sdk-recovery-dx.md) intact.

## Creation defaults belong in adapter setup

Allow `client.sandboxes.create()` and `create({ labels: ... })` when the adapter can resolve a default environment. An explicit per-call environment takes precedence. `checkCreate()` and `submitCreate()` resolve exactly the same defaults as `create()`; checking support must not provision resources.

Implemented setup, using existing E2B terminology and one additional Daytona option:

```ts
const e2bClient = await Sandbar.connect(e2b({
  apiKey: process.env.E2B_API_KEY!,
  templateId: "base", // existing option; also supplies create()'s default
}));

const daytonaClient = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
  environment: Image.prepared("my-project-image"), // default for omitted per-call environments
}));

// Application code is identical with either configured client.
const box = await client.sandboxes.create();
const tagged = await client.sandboxes.create({ labels: { job: "report" } });

// This call overrides the configured environment without changing later calls.
const custom = await client.sandboxes.create({
  environment: Image.prepared("another-project-image"),
});
```

`my-project-image` and `another-project-image` are caller-provisioned identifiers, not bundled images. E2B already defaults its template to `base`; reuse that configuration instead of adding a competing default-template field. For Daytona, require a configured or per-call environment until a documented native default is deliberately supported. Missing both produces an actionable `INVALID_ARGUMENT` before sandbox creation: configure `daytona({ environment: ... })` or pass `create({ environment: ... })`.

The public input is the existing `CreateInput` with optional `environment`; create/check/submit accept an omitted input. Resolve it to a required environment before the existing adapter create boundary. The optional adapter session `defaultImage` supplies the default; keep this extension minimal; do not make every provider's native create input optional or invent a general configuration registry.

Defaults are explicit values, not a fallback search. Validate overrides normally: a foreign scoped image rejects before creation; an unavailable template does not fall back to `base`; an OCI image does not cause an unrequested build. Preserve the existing build/restore paths. Never substitute a new sandbox after an uncertain create. Returned sandbox references remain persistable using the shipped contract.

This slice does not change network defaults, lifetime policy, image resolution, snapshot restore, mounts or permissions. In particular, an omitted network policy stays blocked under the existing contract. Daytona's explicit provider-managed egress configuration still requires its current per-call selection; simplifying that is a separately reviewed networking decision. Do not bundle CPU/memory sizing or create-time environment variables into this change.

## Text files without encoding boilerplate

Implementation status: implemented. Thin SDK wrappers and deterministic/packed Node/Bun coverage; no new native operation or live evidence.

Text helpers sit alongside byte methods and inherit their options and bounds; consult the current exports for exact signatures.

```ts
const box = await client.sandboxes.create();
try {
  await box.writeTextFile("/tmp/input.json", JSON.stringify({ name: "Ada" }));
  await box.exec(["python", "/app/report.py", "/tmp/input.json"]);
  const report = await box.readTextFile("/tmp/report.txt");
  console.log(report);
} finally {
  await box.destroy();
}
```

The example assumes the configured image contains `/app/report.py`. Helpers use UTF-8: writing encodes once; reading decodes the complete bounded byte result with standard replacement for malformed UTF-8 and normal UTF-8 BOM handling. They do not parse JSON, normalize newlines, silently shorten text, create parent directories or auto-resume a sandbox. Binary callers retain `readFile`/`writeFile`.

Reuse byte-operation limits, path validation, cancellation and errors. Limits count encoded bytes, not JavaScript string length. A read over the limit fails rather than returning a successful prefix. A write defaults to `overwrite: false`; updating an existing file requires `{ overwrite: true }`. Empty text is valid. A lost write acknowledgement remains uncertain and is never retried. A failed local read never means the sandbox was terminated.

## Slice 3 implementation contract and native evidence

Daytona and E2B now implement complete bounded `listFiles`, useful `readDirectory`, metadata, existence, mkdir/remove, copy/move, streaming transfers, traversal and text lines. The original #59 native-only unsupported table is superseded by the adapter-owned helper mappings in the [filesystem contract](filesystem-dx.md). The [files guide](../apps/docs/src/content/docs/docs/guides/files-and-output.md) and compiled [artifact workflow](../apps/docs/examples/directory-files.ts) document current usage and image prerequisites.

Directory operations retain absolute-path validation, deterministic immediate child names, bounded results and explicit recursion. `fileExists` returns false only for confirmed absence, including correct dangling-link identity; permissions, authentication and transport failures reject. Remove refuses lexical root paths and never follows final/descendant symlinks during recursion. Intermediate parent links follow the guest namespace; these APIs are not a confinement boundary. Unsupported operations reject before mutation, and uncertain mutations are never replayed.

Creation defaults have deterministic SDK/native-boundary fixtures and packed consumer coverage. Their configured-creation live scenario remains not-run. Local text encoding needs no separate provider qualification. Earlier E2B directory evidence at `3188e33` covers its recorded #59 subset; expanded filesystem evidence is tracked by the current filesystem contract and [provider support](../apps/docs/src/content/docs/docs/providers/support.md), without retroactively widening earlier runs.
