# Finite stdin for ordinary execution

Implementation contract · Merged in PR #71 · October 6, 2026

## Implemented surface in PR #71

Ordinary `box.exec` accepts an optional finite input payload:

```ts
const result = await box.exec({
  command: { kind: "argv", argv: ["cat"] },
  stdin: "hello 🌊",
});
```

Strings are encoded as UTF-8. `Uint8Array` input is copied from the supplied view and preserves exactly those bytes, including NUL and non-text data. The maximum payload is 1 MiB; validation happens before provider dispatch and before retaining an oversized mutable buffer. Supplying an empty string or byte array still requests input completion. Omitted input also means guest stdin is closed. Every supported adapter delivers the finite bytes and then establishes EOF before it can report confirmed command success. Output remains separate stdout/stderr with the existing capture bound and ordinary exit behavior.

This contract does not promise a pipe, seekable file or particular guest descriptor implementation. It does not add input to `processes.start`, a stream source, interactive input handle, PTY, process supervisor, or a new provider. Applications keep the same `exec` call when changing adapters; provider mechanics and limitations stay in adapter setup/documentation.

Adapters opt into the guarantee with `exec.finiteStdin: "bytes"`. An adapter without that declaration rejects an explicitly supplied input as `UNSUPPORTED` before native effects. The adapter runtime bounds and validates bytes, and the SDK rejects runtime-cast input on `processes.start` rather than dropping it. No input payload enters recovery tokens, diagnostics or telemetry.

## Provider mappings and uncertainty

Daytona and E2B reserve a private per-execution staging directory, upload and verify the exact bytes, then redirect the guest command's stdin from that file. Without explicit input, both wrappers redirect from `/dev/null`. They use the existing bounded output/exit capture and recovery paths. A positive exclusive directory reservation is required before upload; a lost or rejected reservation acknowledgement never authorizes upload or cleanup. Setup or byte-verification uncertainty prevents command dispatch, and the SDK never replays staging or command start. A stage can remain after an interrupted or uncertain launch until the command wrapper cleans it or the sandbox is removed.

Experimental Modal starts the existing command once, sends the finite bytes and EOF through its router, then observes the original execution ID. It records only whether input delivery was acknowledged. A lost start/input/EOF acknowledgement remains unknown even if a later command result exists; a result is accepted after delivery only when the full input-plus-EOF acknowledgement was confirmed. Input is never resent during observation. Omitted input sends empty input followed by EOF.

Shared public SDK fixtures exercise the actual command's read-to-EOF behavior and exact stdout bytes across all three adapters. Native-boundary fixtures cover staging and router outcomes; packed Node/Bun consumer coverage checks the published API shape. These are deterministic/packed evidence only. No live finite-input provider qualification is claimed here.

## Future work

Incremental input for `processes.start`, streaming sources, interactive shells and terminal behavior require separate contracts for concurrent output, backpressure, write acknowledgement, cancellation and EOF. They are not inferred from this finite-exec implementation. Tensorlake, boxd and Vercel remain future design examples; this slice does not add their adapters.
