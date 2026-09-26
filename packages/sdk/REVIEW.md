# SDK review record

## Round 1

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `1577b8f4dcd57547517422b19cf4cd3b9e6a0bbc` (`codex/portable-core`).
- Reviewed HEAD: `0573cf8eb900048f3623a8002b79fe38bfebd97a` (`codex/typescript-sdk`).
- Four actionable findings: remote output could exceed request bound; recovered remote executions lacked complete identity/status/output checks; direct oversized writes could yield unrecoverable references; remote bearer tokens could travel over non-loopback HTTP.
- Fixes: bounded combined remote output before return, correlated recovered executions and preserved unknowns, rejected direct writes above 1 MiB before submission, and required HTTPS except literal loopback HTTP. Added focused tests for the latter three. Round 1 is **not** a zero-finding clearance.
- Validation after fixes: `bun run check` passed; `bun test packages/sdk/src/sdk.test.ts` passed 7/7.

This checkpoint preceded final parent integration.

## Round 2

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `1577b8f4dcd57547517422b19cf4cd3b9e6a0bbc`.
- Reviewed HEAD: `fa109ed400304b1be80f7bc5b3394adb2e617f1d`.
- Two actionable findings: direct file paths permitted NUL and traversal components unlike the remote service; direct operation polling continued after client close.
- Fixes: shared file path validation now precedes direct and remote reads/writes; direct operation handles observe client closure and close aborts pending waits. Remote waits also stop on client close. Added path and close tests. Round 2 is **not** a zero-finding clearance.
- Integration: rebased onto reviewed parent `d4a91f395e149f53baf0231e518410deff5eb83f`. `bun run check` and `bun run build` passed. Full `bun test`: 51 passed, one MySQL 8.4 test skipped because no MySQL instance was configured, zero failed; browser E2E passed.

Final complete-diff Luna-high review of the integrated result remains pending.

## Round 3

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `0d614844dfe9661e82f1d9d99141f811a33b7a3a`.
- One actionable finding: direct recovery reported incomplete destroy and file-write receipts as successes. Recovery now requires confirmed compute stop or a complete exact-length file receipt. Added synthetic normalized-result regression test.
- Validation after fix: SDK tests 9/9 passed. Round 3 is **not** a zero-finding clearance.

Production package export/build integration and a new complete-diff review remain pending.

## Packaging integration

- Cherry-picked focused production packaging commit `e6e8048` from qualification task as `b7bc5ef` into SDK branch, after recovery fix `2ca2c53`. This adds ESM JavaScript and declaration builds/exports for SDK, contracts, SPI, core, and fake client/server, plus build order and an import-safe fake server/CLI split. The qualification child retains independent packed-consumer tests and CI.
- `bun run check` passed, including portable package builds and TypeScript checks.
- `bun run test` passed: 52 tests, one MySQL 8.4 test skipped without a configured instance, zero failures; browser E2E passed.
- `bun run build` passed. Node 26.4.0 and Bun 1.3.14 imported `@sandbar/sdk/direct`, `@sandbar/sdk/remote`, and `@sandbar/provider-fake/client` from the SDK package scope.

Final Luna-high complete-diff review of this packaged result remains pending.

## Round 4

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `42bd0fc98f79f49b085c45846652b1f3a823d25b`.
- Two actionable findings: remote recovery accepted incomplete or mismatched destroy/file-write results; `bun.lock` omitted the newly declared core package version.
- Fixes: remote recovery now validates result kind, compute stop, and complete exact file receipt; remote file-write references carry path and byte count without file contents. Added recovery regression tests. Updated core workspace lock metadata and verified `bun install --frozen-lockfile` passes.
- Validation after fixes: `bun run check` passed; full `bun run test` passed 53 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 4 is **not** a zero-finding clearance.

Final complete-diff review after these fixes remains pending.

## Round 5

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `04b015d56751d80a6a9f1a3d45b897045b7c67a5`.
- One actionable finding: remote file writes sent bytes above the direct SDK's 1 MiB limit and relied on service rejection. Remote now rejects before the HTTP mutation, with a parity test confirming no write request is sent.
- Validation after fix: `bun run check` passed; full `bun run test` passed 53 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 5 is **not** a zero-finding clearance.

## Round 6

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `83c3dda30e3539b93fc1005175edd4adc873a7ea`.
- One actionable finding: nullable execution exit codes were classified as ordinary nonzero exits. The SDK now throws a distinct `NoExitCodeError` with the captured result and applied effect. Direct and remote recovery tests cover this outcome; `NonzeroExitError` remains specific to numeric nonzero exits.
- Validation after fix: `bun run check` passed; full `bun run test` passed 54 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 6 is **not** a zero-finding clearance.

## Round 7

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `3cc58dc8ca5e552209ca9e04b3b2046213477525`.
- One actionable finding: imported file-write recovery references accepted traversal or NUL paths, and kind-incompatible fields. References now use the shared file path validator and reject fields that do not belong to their operation kind. Added invalid reference tests.
- Validation after fix: `bun run check` passed; full `bun run test` passed 54 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 7 is **not** a zero-finding clearance.

## Round 8

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `61c8fe3317816aba76e6cb7f5fd1366ae9fdbd86`.
- One actionable finding: remote recovery with an operation ID did not prove that the ID belonged to the reference's invocation key. Recovery now resolves by invocation key every time and requires the returned operation ID to match when present. Added mismatch regression coverage.
- Validation after fix: `bun run check` passed; full `bun run test` passed 54 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 8 is **not** a zero-finding clearance.

Final independent complete-diff review of the resulting HEAD remains pending.
