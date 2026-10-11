# Everyday filesystem and large transfers

Implemented filesystem contract · F1–F4 traversal/text-line slices delivered; fixture/packed checks and dated live evidence remain separate.

Exact signatures are owned by the [SDK exports](../packages/sdk/src/index.ts) and [public reference](../apps/docs/src/content/docs/docs/reference/typescript.md). See the [files guide](../apps/docs/src/content/docs/docs/guides/files-and-output.md) and compiled [artifact workflow](../apps/docs/examples/directory-files.ts) for current usage.

## Outcome and scope

A developer should be able to explore a sandbox, create directories, move input and output files, inspect metadata, rename/copy artifacts, and transfer files larger than memory-friendly convenience limits. Application code should remain the same across Daytona and E2B, with provider configuration handling native mechanics. Basic filesystem usability is a release priority, not an optional extension behind more adapters.

The implemented baseline includes directory enumeration, metadata/existence, mkdir/remove, text/binary reads and writes, copy/move, and bounded-memory large transfers on both built-ins. Experimental Modal and future adapters can report unsupported operations independently.

Preserve existing methods rather than replacing the SDK with a Node filesystem clone or introducing a second filesystem namespace. This contract extends the shipped [everyday-file contract](sandbox-basics-dx.md) and [read cancellation](interactive-execution-and-access.md). It does not expand volume durability, mount ownership, or snapshot guarantees.

## Portable abstraction acceptance rule

Design the public SDK and public adapter hooks for Daytona, E2B and future providers such as Tensorlake. The initial built-ins are implementation targets, not the definition of the interface. Future provider support is a design requirement, not a claim that its native behavior has already been researched or qualified.

Application methods express intent and observable results. Adapters own native endpoints, SDK clients, sessions, transport selection, staging, helper commands and cleanup of their implementation resources. A provider needing several native calls for one SDK operation is adapter work, not a reason to make the application orchestrate those calls. Keep provider-name branching out of the portable runtime and application examples.

Options belong in the public method only when the caller has a meaningful choice about behavior. Provider configuration may expose genuine deployment prerequisites or policy choices; it must not require selecting native RPCs, session protocols or unavoidable internal steps. Resolve those mechanics automatically. Low-level adapter hooks normalize outcomes and errors without leaking native response shapes, credentials or transport tokens into ordinary application code.

Missing a native convenience endpoint does not by itself mean the SDK operation is unsupported. Implement a faithful adapter workflow where feasible. Report unsupported before effects when the required behavior truly cannot be delivered; never silently weaken a requested guarantee. Express unavoidable differences as useful facts such as unknown metadata, incomplete output or unsupported signals, rather than provider-specific control flow.

Acceptance includes the same compiled application workflow against both built-in fixtures, plus an independently authored fake adapter with different mechanics. Substituting adapter setup must not require changing method names, supplying native options, or importing a provider SDK. New adapters implementing existing behavior must not require changes to the portable runtime. Add a generic capability only when a new observable behavior genuinely needs one. Review the ordinary example before accepting the internal implementation.

## Filesystem contract

Directory, metadata, copy/move and stream operations are available through the public SDK and optional public adapter hooks. Current exports own exact signatures. Traversal and text-line helpers compose those existing hooks; range reads and batches remain separately scoped follow-ups.

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
| `readDirectory(path, { signal? })` | Return `{ entries: FileEntry[], completeness: 'complete' \| 'unknown', observedAt: string }`. Immediate children, deterministic name ordering, no implicit recursion. Unknown type remains `unknown`; native filtered/skipped-entry behavior makes completeness unknown. Auth/path/transport failures still reject. This is the preferred ordinary browsing API where native completeness cannot be proved. |
| `statFile(path, { followSymlinks?: boolean, signal? })` | Default no final-link following. Return type plus optional `sizeBytes`, `modifiedAt`, `mode`; omitted means unavailable, never zero/current-time fabrication. Explicit follow requires support. Not found rejects; dangling links are entries when not followed. |
| Existing `fileExists(path)` | False only on confirmed entry absence, including correct handling of dangling links. No false for credentials, permission, missing sandbox or transport failure. |
| Existing mkdir/remove | Preserve recursive opt-in, missing-remove success, existing-directory mkdir success and nonrecursive protection. A preflight existence check alone cannot emulate a race-safe nonrecursive delete using a recursive endpoint. |
| `copyFile(source, destination, { overwrite?: boolean, signal? })` | Regular-file bytes only initially, destination no-clobber by default. Existing parents required. Success means completed copy; it does not promise a point-in-time snapshot of a concurrently modified source, metadata cloning or durability. |
| `moveFile(source, destination, { overwrite?: boolean, signal? })` | Native same-filesystem rename of a file or directory, destination no-clobber by default. No hidden copy/delete fallback across filesystems. Reject unsupported collision behavior before mutation; do not promise global atomicity on mounted/object-backed storage. |
| New stream reads/writes | `AsyncIterable<Uint8Array>` output/input with incremental transfer and cancellation. Text convenience remains layered on bounded byte APIs. Write returns transferred byte count after confirmed completion; reads fail on incomplete delivery rather than ending normally. |

The separate directory result is a deliberate compatibility boundary: it permits honest useful browsing without weakening `listFiles` or creating two undocumented interpretations of its array. Entries retain current `FileEntry` names/types. Do not eagerly stat every child and multiply remote requests. A complete result is an enumeration observed during a changing filesystem, not an atomic namespace snapshot.

Keep the existing bounded directory limits initially. Exceeding a limit throws; never mark a locally truncated listing merely unknown. Large-directory pagination/iteration is a follow-up with explicit continuation/end behavior, not a fabricated cursor over a remotely changing array.

## Provider implementation boundary

Daytona and E2B use adapter-owned Python 3 helpers for complete directory/link observations and race-safe filesystem changes. Their private Linux filesystem requires Python 3; no-clobber rename requires Linux `renameat2`. Staged writes require GNU-compatible `ln -T` and hard links. See the maintained [Daytona](../apps/docs/src/content/docs/docs/providers/daytona.md) and [E2B](../apps/docs/src/content/docs/docs/providers/e2b.md) guides for image prerequisites and transport details.

Adapters own native endpoints, staging and cleanup. Helper commands require exact argument handling, bounded output and checked exit status; never parse human-formatted `ls`, interpolate paths into shell programs, install dependencies automatically or expose a persistent service for directory work. Mounted storage must establish the requested publish/rename guarantee separately. Experimental Modal can reject optional filesystem hooks with `UNSUPPORTED`.

Mkdir/remove acknowledgement confirms the call; there is no durable receipt. Pre-abort, root refusal and unsupported requests are effect-free. Cancellation or lost acknowledgement after dispatch retains an ordinary scoped recovery reference with path and recursive intent. Recovery never repeats the native call, and a later existence check alone cannot prove that the uncertain mutation completed.

## Transfer limits, cancellation and partial effects

Retain the current 1 MiB buffered defaults for compatibility. Convenience reads/writes accept an explicit bounded `maxBytes` override, with a 16 MiB ceiling; larger data uses streams. Validate the effective limit before dispatch when length is known. A read exceeding its bound rejects instead of returning truncated data. The implementation must address both SDK and native-client buffering, not just remove validation.

Streams split admitted large chunks to at most 64 KiB with bounded queued bytes/chunks. One producer and one consumer, awaited incremental IO, no unbounded pending writes. No default whole-file size ceiling for streams; callers can set `maxBytes`. This is an application-memory bound, not a promise about remote caches or one native frame allocation. Verify the transport does not secretly buffer the entire file.

Separate setup, inactivity and optional overall timeout. Stream defaults: 30-second setup, 60 seconds without network progress while actively demanding/sending data, no overall timeout unless supplied. Consumer processing time must not trigger network-idle failure. Configuration lives on the SDK connection with per-transfer override; use `transfers: { setupTimeoutMs, inactivityTimeoutMs, overallTimeoutMs }` on the SDK connection or the same fields in per-transfer options. Local abort/close releases readers/producers promptly and does not imply rollback.

Prefer same-directory staging plus a verified final publish operation for writes and copies. Preserve no-clobber under concurrency; check-then-write is insufficient. Do not label staging as universal atomic replacement. If a backend cannot stage/publish, return unsupported for a requested guarantee instead of silently exposing a partial destination. Retain known temporary paths and destination effects when cancellation, lost acknowledgement or cleanup failure leaves artifacts. Automatic cleanup can remove only a correlated staging artifact, not a caller's file; never replay an uncertain publish/copy/move.

Confirmed transfer completion stays confirmed when later metadata inspection fails. Preserve source/destination and any known effect in existing typed errors; do not build another recovery journal. Do not trace contents, credentials or high-cardinality chunk events. One semantic operation span records bytes, duration and outcome under current privacy rules.

## Traversal and text lines

`walkFiles` composes directory reads into deterministic depth-first traversal: the root is omitted, immediate children have depth 1, and directories precede descendants. Symlinks and unknown types are yielded without descent. Unknown enumeration completeness, unreadable subtrees and entry-budget overflow reject. Defaults are depth 32 and 10,000 observed entries. Exclusions are exact canonical root-relative paths; excluded entries count against the budget and excluded directories prune subtrees. This observes a changing namespace, not a snapshot or confinement boundary.

`readTextLines` incrementally decodes UTF-8 over file streams, handling split code points and CRLF. It strips LF/CRLF, preserves lone CR and emits a final unterminated line without an extra empty line after a delimiter. Malformed UTF-8 uses replacement. The default maximum line is 1 MiB of source bytes excluding the delimiter; oversize rejects `OUTPUT_CAPACITY`. Transfer limits, cancellation and timeout overrides apply.

Range reads, batch transfers, search/glob, tree copy, watch, append, chmod, symlink creation and locks need separately scoped contracts; they are not inferred from this baseline.

## Qualification boundary

Directory/link fixtures cover unusual names, unknown types, dangling/intermediate links, permission failures and capacity. Transfer fixtures cover bounded memory, exact bytes, abort, blocked consumers/producers, no-clobber races, lost acknowledgements and staging cleanup. Copy/move fixtures preserve same-path rejection, source retention, overwrite refusal and cross-filesystem refusal. Public workflows and packed consumers exercise the shared SDK and independently authored adapters.

Historical live passes at `2f6afe8` predate traversal/text lines. The expanded artifact recipe passed at `e91f2d5` on both borrowed provider images with confirmed owned cleanup, including a 32 MiB SHA-256 stream check. [Provider support](../apps/docs/src/content/docs/docs/providers/support.md) retains exact source/configuration and cleanup outcomes separately from earlier file/directory evidence. These records do not qualify arbitrary mounted storage or images. New live calls require separate authorization.
