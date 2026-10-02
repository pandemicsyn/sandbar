# Default creation and everyday files

Implementation contract · Creation defaults (#58), text helpers (#61) and directory APIs (#59) merged · October 2, 2026

Make the ordinary workflow short: configure a provider once, create a sandbox, write an input, run a command, read its output and clean up. Creation defaults, text helpers and directory APIs are merged. Exported directory methods retain the unsupported native mappings below; configured creation and directory live cases remain not-run. Keep resource references, scope checks and [ordinary recovery semantics](sdk-recovery-dx.md) intact.

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

Helpers sit alongside the existing byte methods, without overloading or changing those methods:

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

Slice 3 implements the following SDK signatures with optional adapter methods; live qualification remains pending. The verified built-in subset and unsupported mappings are documented below:

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

## Merged delivery slices and acceptance

1. **Creation defaults.** SDK/adapter default resolution and built-in setup, public types, provider docs and compiled examples. Test no-argument creation, labels-only creation, override precedence, absent defaults, foreign scoped images, and parity across check/submit/create. Native fixtures assert the resolved environment reaches exactly one create request.
2. **Text helpers.** Thin wrappers, focused UTF-8/empty/multibyte/limit/overwrite/cancellation tests and packed Node/Bun examples. Reuse existing instrumentation without duplicate provider-call spans. No new native operation or live run is needed to establish encoding behavior.
3. **Directory primitives.** First record pinned Daytona/E2B native mappings, error codes, symlink behavior and result bounds in this spec. Implement only demonstrated mappings, with native-boundary fixtures and maintained live acceptance cases. Unsupported mappings stay documented; do not hold all primitives for universal parity.

Creation defaults merged in #58, text helpers in #61 and directory primitives in #59. These acceptance boundaries describe the shipped slices, not a pending coding queue. Live evidence remains not-run until separately authorized and recorded. Run the repository checks appropriate to public API/package changes, including packed examples and docs.

## Slice 1 implementation status

Creation defaults have deterministic SDK/native-boundary fixtures, compiled provider examples and packed consumer coverage. The maintained sandbox acceptance setup now exercises configured creation for Daytona and E2B; no live run has been performed for this slice. Native create dispatch still requires an image and keeps existing networking, build, restore and uncertainty semantics. Text helpers, directory APIs and preview access shipped in separate PRs.

## Slice 3 implementation contract and native evidence

Slice 3 merged in #59 with optional adapter operations; live qualification remains not-run. Creation defaults and text helpers retain their own status above.

Listings have a fixed ceiling of 1,024 entries and 65,536 UTF-8 bytes in child names (summed, excluding metadata). The SDK validates names/types, rejects duplicate names and invalid child names, sorts in code-unit order and raises `OUTPUT_CAPACITY` on overflow. Adapters must return a complete immediate listing or reject; a native API that silently filters entries cannot implement this contract. These are result bounds, not a claim that a provider's unpaginated server bounds its allocation. No built-in listing is enabled in this slice.

| Operation | E2B mapping | Daytona mapping |
| --- | --- | --- |
| `listFiles` | Unsupported: `e2b@2.51.0` `files.list({ depth: 1 })` filters protobuf unknown types, including dangling symlinks reported as unknown. | Unsupported: inspected `GET /files` skips failed detail lookups and uses target-following `os.Stat`, losing dangling links and link identity. |
| `fileExists` | Native `files.exists` / `Filesystem.Stat`; only guest RPC `NotFound` means false. Attachment/control-plane failures propagate. | Unsupported: `GET /files/info` follows the final link; its 404 cannot distinguish a dangling entry from absence. |
| `makeDirectory` | Native `files.makeDir` / `Filesystem.MakeDir`, only with `recursive: true`; already-directory succeeds, non-directory rejects. Default/nonrecursive request rejects before mutation. | Unsupported in this slice: `POST /files/folder` uses `MkdirAll`; no demonstrated nonrecursive mapping or deployed-version fixture. |
| `removeFile` | Native `files.remove` / `Filesystem.Remove`, only with `recursive: true`; `os.RemoveAll` removes missing paths successfully and does not walk symlink entries. Default/nonrecursive request rejects before mutation. | Unsupported: inspected DELETE checks target-following `Stat` first, rejects even empty directories without recursion and leaves dangling links untouched on 404. |

Pinned E2B client evidence is the installed `e2b@2.51.0` filesystem source. Server evidence is [infra revision 16f749ccf64db084561ffec6eb9040b98eaf11a9](https://github.com/e2b-dev/infra/tree/16f749ccf64db084561ffec6eb9040b98eaf11a9/packages/envd/internal/services/filesystem): `stat.go`, `dir.go`, `remove.go`, `utils.go`, plus `packages/shared/pkg/filesystem/entry.go`. Stat starts with `Lstat`; link target resolution is best effort, so dangling links remain existing entries. Listing follows its directory operand but not child links; unknown entries are filtered by the pinned JS SDK. MakeDir uses recursive ancestor creation and reports AlreadyExists only for a directory (including a link to a directory). Remove uses `os.RemoveAll`. Native SDK request deadlines and caller signals are forwarded. This source review and deterministic fixtures do not establish the deployed guest version; maintained live cases remain unrun.

Daytona's existing adapter targets REST/toolbox v0.218, but the currently served [toolbox schema](https://www.daytona.io/docs/toolbox-openapi.json) reports `v0.0.0-dev` and does not specify lstat or absence semantics. The pinned public [server revision 01c502bb1f1ff8f2885d0cd490e043736083dca8](https://github.com/daytonaio/daytona/tree/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/daemon/pkg/toolbox/fs) (v0.190) supplies negative evidence, not a guarantee about v0.218 deployment. All four methods therefore remain explicitly unsupported for Daytona until a suitable native boundary is demonstrated.

For these new operations the SDK collapses repeated slashes and removes trailing slashes after existing absolute-path validation. This makes `/link/` refer to the link entry for removal and refuses every lexical root spelling, including `//`. E2B native operations follow intermediate parent symlinks; recursive removal unlinks final/descendant links rather than following their targets. A caller can still address data through a symlinked parent; this API is not a containment/security boundary and does not promise atomic protection against concurrent namespace changes. Root aliases through intermediate symlinks are not a confinement guarantee.

E2B RPC NotFound is absence only in `fileExists`; attachment 404 is `NOT_FOUND` error, not false. Permission/authentication, transport and unsupported failures reject. Mkdir InvalidArgument rejects; other failures after mutation dispatch remain uncertain without replay. A successful acknowledgement confirms the mkdir/remove call; there is no durable receipt and recovery never repeats either native call. SDK pre-abort/root/unsupported failures are effect-free; cancellation or a lost acknowledgement after dispatch retains an ordinary scoped recovery reference with path and recursive intent. Observation without a receipt remains unknown, even if a later existence check matches the desired state.
