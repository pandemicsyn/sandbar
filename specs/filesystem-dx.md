# Everyday filesystem and large transfers

Delivery contract · October 8, 2026 · F1–F3 implemented; fixture/packed checks and dated live evidence remain separate.

## Outcome and scope

A developer should be able to explore a sandbox, create directories, move input and output files, inspect metadata, rename/copy artifacts, and transfer files larger than memory-friendly convenience limits. Application code should remain the same across Daytona and E2B, with provider configuration handling native mechanics. Basic filesystem usability is a release priority, not an optional extension behind more adapters.

The minimum delivery target is working directory enumeration, metadata/existence, mkdir/remove, text/binary reads and writes, copy/move, and bounded-memory large transfers on both built-ins. A provider-limited incremental PR is useful, but does not complete the two-provider target. Experimental Modal and future adapters can report unsupported operations independently.

Preserve existing methods rather than replacing the SDK with a Node filesystem clone or introducing a second filesystem namespace. This plan extends the shipped [everyday-file contract](sandbox-basics-dx.md) and [read cancellation](interactive-execution-and-access.md). It does not expand volume durability, mount ownership, or snapshot guarantees.

## Portable abstraction acceptance rule

Design the public SDK and public adapter hooks for Daytona, E2B and future providers such as Tensorlake. The initial built-ins are implementation targets, not the definition of the interface. Future provider support is a design requirement, not a claim that its native behavior has already been researched or qualified.

Application methods express intent and observable results. Adapters own native endpoints, SDK clients, sessions, transport selection, staging, helper commands and cleanup of their implementation resources. A provider needing several native calls for one SDK operation is adapter work, not a reason to make the application orchestrate those calls. Keep provider-name branching out of the portable runtime and application examples.

Options belong in the public method only when the caller has a meaningful choice about behavior. Provider configuration may expose genuine deployment prerequisites or policy choices; it must not require selecting native RPCs, session protocols or unavoidable internal steps. Resolve those mechanics automatically. Low-level adapter hooks normalize outcomes and errors without leaking native response shapes, credentials or transport tokens into ordinary application code.

Missing a native convenience endpoint does not by itself mean the SDK operation is unsupported. Implement a faithful adapter workflow where feasible. Report unsupported before effects when the required behavior truly cannot be delivered; never silently weaken a requested guarantee. Express unavoidable differences as useful facts such as unknown metadata, incomplete output or unsupported signals, rather than provider-specific control flow.

Acceptance includes the same compiled application workflow against both built-in fixtures, plus an independently authored fake adapter with different mechanics. Substituting adapter setup must not require changing method names, supplying native options, or importing a provider SDK. New adapters implementing existing behavior must not require changes to the portable runtime. Add a generic capability only when a new observable behavior genuinely needs one. Review the ordinary example before accepting the internal implementation.

## Original implementation gaps

- `readFile`/`writeFile` and text helpers buffer at most 1 MiB. There is no large-transfer path.
- `listFiles` promises a complete bounded listing with link/unknown types; neither built-in implements it. Native filtering and incomplete entry metadata have prevented useful directory browsing.
- E2B supports existence and explicitly recursive mkdir/remove. Daytona has no mapped directory primitives. Metadata, copy, move and recursive traversal are absent.
- File reads have a fixed local deadline; a large transfer needs a distinct transfer policy rather than inheriting a 30-second whole-file limit.

Unknown entry metadata should not prevent returning known names. Missing information must remain visible, but the default browsing experience must be useful. Do not claim an operation is supported merely because its SDK method exists.

## Proposed interface and ordinary workflow

F1–F3 are available through the public SDK and optional public adapter hooks. Current exports own exact signatures. The optional F4 extensions below remain separately scoped follow-ups.

```ts
await box.makeDirectory('/workspace/results', { recursive: true });
await box.writeTextFile('/workspace/results/report.json', JSON.stringify(report));
const directory = await box.readDirectory('/workspace/results');
for (const entry of directory.entries) console.log(entry.name, entry.type);
const info = await box.statFile('/workspace/results/report.json');
await box.copyFile('/workspace/results/report.json', '/workspace/report-copy.json');
await box.moveFile('/workspace/report-copy.json', '/workspace/final.json');
await box.removeFile('/workspace/results', { recursive: true });

// Input is caller-owned byte chunks, independent of a local filesystem package.
await box.writeFileStream('/workspace/archive.bin', inputChunks, { signal });
for await (const chunk of box.readFileStream('/workspace/archive.bin', { signal })) {
  await destination.write(chunk);
}
```

| Surface | Contract |
| --- | --- |
| Existing `listFiles(path)` | Preserve complete bounded listing and current error behavior. Implement using an adequate native boundary or a narrowly tested guest utility. Do not silently return a successful prefix. |
| New `readDirectory(path, { signal? })` | Return `{ entries: FileEntry[], completeness: 'complete' \| 'unknown', observedAt: string }`. Immediate children, deterministic name ordering, no implicit recursion. Unknown type remains `unknown`; native filtered/skipped-entry behavior makes completeness unknown. Auth/path/transport failures still reject. This is the preferred ordinary browsing API where native completeness cannot be proved. |
| New `statFile(path, { followSymlinks?: boolean, signal? })` | Default no final-link following. Return type plus optional `sizeBytes`, `modifiedAt`, `mode`; omitted means unavailable, never zero/current-time fabrication. Explicit follow requires support. Not found rejects; dangling links are entries when not followed. |
| Existing `fileExists(path)` | False only on confirmed entry absence, including correct handling of dangling links. No false for credentials, permission, missing sandbox or transport failure. |
| Existing mkdir/remove | Preserve recursive opt-in, missing-remove success, existing-directory mkdir success and nonrecursive protection. A preflight existence check alone cannot emulate a race-safe nonrecursive delete using a recursive endpoint. |
| New `copyFile(source, destination, { overwrite?: boolean, signal? })` | Regular-file bytes only initially, destination no-clobber by default. Existing parents required. Success means completed copy; it does not promise a point-in-time snapshot of a concurrently modified source, metadata cloning or durability. |
| New `moveFile(source, destination, { overwrite?: boolean, signal? })` | Native same-filesystem rename of a file or directory, destination no-clobber by default. No hidden copy/delete fallback across filesystems. Reject unsupported collision behavior before mutation; do not promise global atomicity on mounted/object-backed storage. |
| New stream reads/writes | `AsyncIterable<Uint8Array>` output/input with incremental transfer and cancellation. Text convenience remains layered on bounded byte APIs. Write returns transferred byte count after confirmed completion; reads fail on incomplete delivery rather than ending normally. |

The separate directory result is a deliberate compatibility boundary: it permits honest useful browsing without weakening `listFiles` or creating two undocumented interpretations of its array. Entries retain current `FileEntry` names/types. Optional richer metadata can follow once `statFile` settles; do not eagerly stat every child and multiply remote requests. A complete result is an enumeration observed during a changing filesystem, not an atomic namespace snapshot.

Keep the existing bounded directory limits initially. Exceeding a limit throws; never mark a locally truncated listing merely unknown. Large-directory pagination/iteration is a follow-up with explicit continuation/end behavior, not a fabricated cursor over a remotely changing array.

## Provider implementation choices

First inspect the pinned transports and current upstream APIs. Prefer native operations, then a supported lower-level endpoint, then a small adapter-owned guest helper where it materially unlocks common workflows. A subprocess helper is an acceptable implementation strategy; it must have documented image prerequisites, exact argument handling, bounded output and checked exit status. Do not parse human-formatted `ls`, interpolate paths into shell programs, install dependencies automatically, or ship a persistent guest service for directory work.

Current docs checked October 8 show candidate native surfaces, not qualification of our deployed mappings:

- [Daytona filesystem reference](https://www.daytona.io/docs/en/typescript-sdk/file-system/) describes metadata, enumeration, move and stream transfer methods. Investigate those transport boundaries rather than treating the older unsupported mappings as permanent. Verify link identity, skipped entries, collisions, streaming request bodies and cancellation against the chosen version.
- [E2B files](https://docs.e2b.dev/filesystem/read-write) documents reads, writes and batches. The existing pinned integration already establishes useful directory primitives but filters some listing entries. Check newer/native listing and stream boundaries before selecting a helper or upgrading dependencies.

For each selected mapping, record the endpoint/helper, SDK/server version evidence, native request fields, supported path/link behavior and exact limitation in the implementation PR. Default to the simplest supported workflow; applications should not choose transport modes per call. An optional alternate dependency belongs in typed adapter setup only when there is a real deployment choice.

## Transfer limits, cancellation and partial effects

Retain the current 1 MiB buffered defaults for compatibility. Add an explicit bounded `maxBytes` override to convenience reads/writes, with a proposed 16 MiB ceiling; larger data uses streams. Validate the effective limit before dispatch when length is known. A read exceeding its bound rejects instead of returning truncated data. The implementation must address both SDK and native-client buffering, not just remove validation.

Stream defaults: proposed 256 KiB queued bytes with a chunk-count bound of 64; split admitted large chunks to at most 64 KiB. One producer and one consumer, awaited incremental IO, no unbounded pending writes. No default whole-file size ceiling for streams; callers can set `maxBytes`. This is an application-memory bound, not a promise about remote caches or one native frame allocation. Verify the transport does not secretly buffer the entire file.

Separate setup, inactivity and optional overall timeout. Proposed stream defaults: 30-second setup, 60 seconds without network progress while actively demanding/sending data, no overall timeout unless supplied. Consumer processing time must not trigger network-idle failure. Configuration lives on the SDK connection with per-transfer override; exact option wiring must be settled in F2 alongside cancellation tests. Local abort/close releases readers/producers promptly and does not imply rollback.

Prefer same-directory staging plus a verified final publish operation for writes and copies. Preserve no-clobber under concurrency; check-then-write is insufficient. Do not label staging as universal atomic replacement. If a backend cannot stage/publish, return unsupported for a requested guarantee instead of silently exposing a partial destination. Retain known temporary paths and destination effects when cancellation, lost acknowledgement or cleanup failure leaves artifacts. Automatic cleanup can remove only a correlated staging artifact, not a caller's file; never replay an uncertain publish/copy/move.

Confirmed transfer completion stays confirmed when later metadata inspection fails. Preserve source/destination and any known effect in existing typed errors; do not build another recovery journal. Do not trace contents, credentials or high-cardinality chunk events. One semantic operation span records bytes, duration and outcome under current privacy rules.

## Useful extensions after the baseline

| Extension | Proposed behavior / ordering |
| --- | --- |
| `walkFiles` | Bounded async traversal with max depth, entry budget, explicit exclusions and no symlink following by default. Build after directory semantics; fail visibly on unreadable subtrees. |
| `readTextLines` | Incremental UTF-8 decoding over byte streams, correct split code points/newlines, bounded maximum line length and explicit oversize failure. Useful for logs and datasets without whole-file buffering. |
| `readFileRange` | Exact byte offset/length for previews and large artifacts; short reads allowed only at confirmed EOF. No pretend range implementation that downloads the entire file. |
| Batch transfer | Bounded concurrency and per-file outcomes for project upload/download; no all-or-nothing claim. Add after single-file transfer is reliable. |
| Search/glob and tree copy | Define matching, exclusions, cancellation and partial results separately; prefer composing traversal before a provider-specific search abstraction. |
| Watch, append, chmod, symlink creation, file locks | Defer until a concrete use case/native guarantee justifies each. Do not infer these from basic file support. |

## Delivery slices and acceptance

Keep contracts shared and provider changes independently reviewable. Split either provider mapping into its own PR if necessary; no requirement to fit an entire row into one large PR.

1. **F1 — Useful directory operations and metadata.** Add `readDirectory`/`statFile`; implement usable Daytona/E2B listing, mkdir/remove/existence, preserve strict legacy methods and add compiled file-browser workflow. Resolve link/type/completeness details at the native boundary. Fixtures cover unusual names, permission failure, unknown types, dangling/intermediate links, concurrent deletion and capacity. No transfer framework in this slice.
2. **F2 — Large byte transfers.** Stream reads first, then writes and buffered overrides as separate small PRs if needed. Verify steady memory with a slow source/sink, files at least 32 MiB, zero-byte/binary payloads, pre/post-dispatch abort, producer failure, blocked consumers, no-clobber races, acknowledgement loss and staging cleanup. Include full bytes/hash validation and prompt cancellation; a streaming-shaped API around whole-file buffering fails acceptance.
3. **F3 — Copy/move and a complete artifact workflow.** Test overwrite refusal, same-path behavior (reject), existing destination, directories for move, symlinks (reject file-copy operands initially), cross-filesystem refusal and source retention on failure. Add a compiled create/write/list/stat/copy/move/download/cleanup recipe. Do not require stronger volume durability to ship basic file copying.
4. **F4 — Selected extensions.** Start with traversal and text lines if the first three slices demonstrate demand. Each is optional and separately scoped; basic usability does not depend on all extensions.

Use existing Bun integration suites and native-boundary fixtures. Each slice updates adapter conformance tests, public examples, provider docs and generated support inputs; offline checks and live evidence remain distinct. Bounded, separately authorized Daytona/E2B runs must exercise the public methods and verify artifact cleanup before claiming live support. Reuse one owned sandbox per provider where practical; no builds, volumes or snapshots are required for ordinary private-filesystem qualification. Test mounted storage separately when claiming its behavior.

Implementation PRs need independent correctness and DX review before opening the PR, plus the relevant package, packed-consumer and docs gates. The user owns final review/merge. This plan itself authorizes no live resources. F1–F3 now have shared public methods, Daytona/E2B mappings, native-boundary fixtures and a compiled artifact recipe. F4 remains optional. The expanded live directory case invokes that same recipe and verifies a 32 MiB stream by SHA-256; support records retain its exact source and cleanup outcome separately from historical file/directory passes.
