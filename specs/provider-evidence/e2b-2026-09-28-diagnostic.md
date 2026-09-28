# E2B diagnostic live rerun — 2026-09-28 UTC

## Authorization and provenance

The user explicitly authorized this diagnostic rerun after offline diagnostics tests and independent review. Maximum one sandbox, native lifetime 300 seconds, no image builds, borrowed public `base` template, and owned cleanup. No further live attempt was made.

- Exact merged SDK: `626b47b396c6a57267cd9942c1e40b9e5ba305a0`.
- Exact clean harness: `925270bde2794005909cf6e95fd27188c316ec96`, independently reviewed in full by gpt-6-luna/high with zero actionable findings.
- Runtime: Bun 1.3.14, macOS arm64; native dependency E2B 2.51.0.
- API-key authentication, public `base`, no team ID/API-key ID. Blocked internet requested; egress isolation not measured.
- Deployed envd: `0.6.10`, obtained from the owned sandbox's bounded public info read.
- Elapsed: approximately 8.13 seconds. Owned termination and connection close confirmed.

## Captured failure

Eleven scenarios passed. **File overwrite failed during the write stage**, before the harness's read/comparison step. No-clobber was blocked by its failed prerequisite without another write; OCI was not run.

The [sanitized report](../../packages/sdk-qualification/provider-qualification/results/e2b-2026-09-28-base-diagnostic.json) records:

- Error name: `OutcomeUnknownError`.
- Code: `OUTCOME_UNKNOWN`; public issue: `outcome-unknown`.
- Message: `E2B written bytes differ from the submitted content`.
- Stage: `write`; elapsed for this scenario: 1687 ms.
- Expected/submitted bytes: `[2, 254, 0]`, length 3; overwrite enabled.
- Diagnostic appended durably before teardown. Private raw console/ledger remain outside the repository. No credentials, native IDs or recovery references are published.

## What this establishes

Initial binary write/read passed for `[0, 255, 1, 128]`. The later three-byte overwrite did not complete with verified content. In the exact merged provider, the write submission uses native `sandbox.files.write` with a Blob. Its public write operation then observes the target through `transport.read` and rejects confirmation if the read is truncated, its length differs from the submitted length, or its SHA-256 digest differs. The captured message originates from that verification branch in `packages/providers/e2b/src/index.ts`.

This locates the failed guarantee: successful confirmed overwrite through the current E2B provider. It does not identify which native readback condition failed. The provider does not expose its internal readback bytes in the thrown error, and the harness's read never ran because `writeFile` threw. Actual returned bytes and length are therefore unavailable; no trailing-byte or append hypothesis is claimed as proven.

The original [live run](e2b-2026-09-28.md) and JSON remain unchanged. This newer diagnostic record supersedes the earlier result for the same tested configuration in the generated matrix, while preserving historical evidence.

## Handoff

Investigate the native transport overwrite/readback semantics using deterministic provider fixtures first. Capture bounded actual readback bytes/length on a failed overwrite before teardown while preserving the original write-stage error; the current useful error still omits the provider's internal observations. Coordinate any provider changes through the manager. No-clobber stays blocked until overwrite passes. Another live verification requires separate authorization; this run has already terminated its one owned sandbox.
