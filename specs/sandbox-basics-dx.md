# Default creation and everyday files

Accepted product direction · Proposed API · October 2, 2026

Make the ordinary workflow short: configure a provider once, create a sandbox, write an input, run a command, read its output and clean up. This is the next implementation work after [suspend/resume](sandbox-lifecycle.md). Signatures below are proposals, not current exports. Keep resource references, scope checks and [ordinary recovery semantics](sdk-recovery-dx.md) intact.

## Creation defaults belong in adapter setup

Allow `client.sandboxes.create()` and `create({ labels: ... })` when the adapter can resolve a default environment. An explicit per-call environment takes precedence. `checkCreate()` and `submitCreate()` resolve exactly the same defaults as `create()`; checking support must not provision resources.

Concrete proposed setup, using existing E2B terminology and one additional Daytona option:

```ts
const e2bClient = await Sandbar.connect(e2b({
  apiKey: process.env.E2B_API_KEY!,
  templateId: "base", // existing option; also supplies create()'s default
}));

const daytonaClient = await Sandbar.connect(daytona({
  apiKey: process.env.DAYTONA_API_KEY!,
  target: "us",
  environment: Image.prepared("my-project-image"), // proposed setup option
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

Proposed public input is the existing `CreateInput` with optional `environment`; create/check/submit accept an omitted input. Resolve it to a required environment before the existing adapter create boundary. Expose only the minimal adapter authoring extension needed to supply a default; do not make every provider's native create input optional or invent a general configuration registry.

Defaults are explicit values, not a fallback search. Validate overrides normally: a foreign scoped image rejects before creation; an unavailable template does not fall back to `base`; an OCI image does not cause an unrequested build. Preserve the existing build/restore paths. Never substitute a new sandbox after an uncertain create. Returned sandbox references remain persistable using the shipped contract.

This slice does not change network defaults, lifetime policy, image resolution, snapshot restore, mounts or permissions. In particular, an omitted network policy stays blocked under the existing contract. Daytona's explicit provider-managed egress configuration still requires its current per-call selection; simplifying that is a separately reviewed networking decision. Do not bundle CPU/memory sizing or create-time environment variables into this change.

## Text files without encoding boilerplate

Add helpers alongside the existing byte methods, without overloading or changing those methods:

```ts
readTextFile(path: string, options?: ReadOptions): Promise<string>;
writeTextFile(
  path: string,
  text: string,
  options?: { overwrite?: boolean; signal?: AbortSignal },
): Promise<void>;
```

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

## Directory operations for ordinary application work

A following small slice adds the missing primitives; these are proposed SDK signatures, with optional adapter methods rather than an obligatory emulation layer:

```ts
type FileEntry = {
  name: string; // immediate child name, not a recursive path
  type: "file" | "directory" | "symlink" | "unknown";
};
listFiles(path: string, options?: ReadOptions): Promise<FileEntry[]>;
makeDirectory(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>;
fileExists(path: string, options?: ReadOptions): Promise<boolean>;
removeFile(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>;
```

```ts
await box.makeDirectory("/tmp/job/results", { recursive: true });
await box.writeTextFile("/tmp/job/results/summary.txt", "Done\n");
const entries = await box.listFiles("/tmp/job/results");
if (await box.fileExists("/tmp/job/results/summary.txt")) {
  console.log(await box.readTextFile("/tmp/job/results/summary.txt"));
}
await box.removeFile("/tmp/job", { recursive: true });
```

Behavior requirements:

- All paths use the existing absolute-path validation. `listFiles` lists immediate children without `.` or `..`, sorted by name using deterministic code-unit order. It never silently truncates: set and document bounded entry/byte limits in the implementation contract, then fail clearly on overflow. Pagination, recursive walking and metadata inventories are outside this slice.
- `makeDirectory` without recursion requires an existing parent; an existing directory succeeds, but an existing non-directory fails. Recursion creates missing ancestors only when requested.
- `fileExists` means an entry exists, including a dangling symlink. Return false only for confirmed absence, never for authentication, permission, transport or unsupported-operation failures. It is an observation, not a lock or safe check-before-write mechanism.
- `removeFile` removes a file, symlink or empty directory. Nonempty directories require `recursive: true`; missing entries succeed. Refuse sandbox root deletion. Recursive removal must not follow symlink entries into their targets. Resolve the precise parent-symlink behavior in native fixtures and docs before enabling an adapter; do not claim this API is a filesystem security boundary.
- Never implement convenience methods by interpolating paths into arbitrary shell commands. Prefer native file APIs; any necessary command mapping must be explicitly reviewed, correctly quoted and fixture-tested before enabling support. Do not install a hidden guest daemon.
- Unsupported operations reject before mutation. Support is per operation; text helpers require only the existing read/write support. Do not force users to perform capability negotiation before ordinary calls.

## Small delivery slices and acceptance

1. **Creation defaults.** SDK/adapter default resolution and built-in setup, public types, provider docs and compiled examples. Test no-argument creation, labels-only creation, override precedence, absent defaults, foreign scoped images, and parity across check/submit/create. Native fixtures assert the resolved environment reaches exactly one create request.
2. **Text helpers.** Thin wrappers, focused UTF-8/empty/multibyte/limit/overwrite/cancellation tests and packed Node/Bun examples. Reuse existing instrumentation without duplicate provider-call spans. No new native operation or live run is needed to establish encoding behavior.
3. **Directory primitives.** First record pinned Daytona/E2B native mappings, error codes, symlink behavior and result bounds in this spec. Implement only demonstrated mappings, with native-boundary fixtures and maintained live acceptance cases. Unsupported mappings stay documented; do not hold all primitives for universal parity.

Slices 1 and 2 may share a small PR if their diff remains easy to review. Do not combine directory work, networking or process management into it. Public docs distinguish proposed work from shipped exports until merge; update provider support reporting for newly exposed operations. Live evidence remains not-run until separately authorized and recorded. Run the repository checks appropriate to public API/package changes, including packed examples and docs.
