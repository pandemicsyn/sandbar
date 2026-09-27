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

## Round 9

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `546045ce7f285df6759bb88008dd6da0eb66e564`.
- Two actionable findings: closing during a dispatched mutation could hide the accepted effect behind a no-effect `CLIENT_CLOSED` error; abort/close could hang while observation was in flight. Mutation convenience methods now preserve and surface an `OutcomeUnknownError` with the preallocated reference after close, and waits race read-only observation against abort/close signals. Added direct and remote race regressions.
- Validation after fixes: focused SDK tests 14/14 passed; `bun run check` passed; full `bun run test` passed 57 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 9 is **not** a zero-finding clearance.

## Round 10 — zero findings

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `10a0afd04df836d5c064a355a54ed31e9b793e66`.
- The reviewer inspected the complete diff, including SDK recovery and close behavior, package exports, fake provider split, and surrounding core/SPI/service context. It reported **zero remaining actionable findings**.
- Final pre-review validation: focused SDK tests 14/14; `bun run check`; full `bun run test` 57 passed, one MySQL 8.4 skip, zero failed, browser E2E passed. `bun install --frozen-lockfile` and package-scope Node 26.4.0/Bun 1.3.14 imports passed earlier on the packaged branch.

## Round 11

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `48e4178a80408e7346c148ee1182ba713ee3ddab`.
- One actionable finding: aborting an ordinary mutation after dispatch hid the internally allocated recovery reference. Ordinary direct and remote create/exec/file-write/destroy now throw `WaitAbortedError` with the reference and original abort cause, while a pre-aborted signal is rejected before dispatch. Added controlled after-dispatch tests for both backends.
- Validation after fix: focused SDK tests 16/16 passed; `bun run check` passed; full `bun run test` passed 59 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 11 is **not** a zero-finding clearance.

Final independent complete-diff review of the resulting HEAD remains pending.

## Round 12

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `e9b364635d10494663e10223b362dc601e9605a5`.
- Three actionable findings: remote create did not compare the operation sandbox ID with its result sandbox ID; remote file reads allocated the full response before applying the SDK limit; and the shared file path validator accepted `.` segments. Both create and recovery now check sandbox identity, file reads enforce a streaming 1 MiB limit and cancel oversized streams, and direct/remote paths and recovery references reject `.` segments.
- The qualification review also identified a cancellation gap while mutation submission remained pending, including direct create preparation. Direct creation checks abort after each preparation await and before dispatch. Direct provider mutations and remote service submissions now race against abort and client close, returning the allocated recovery reference after possible dispatch. Gated tests confirm prompt settlement before the provider or HTTP response is released, and no create dispatch after abort during preparation.
- Validation after fixes: focused SDK tests 19/19 passed; `bun run check` passed; full `bun run test` passed 62 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 12 is **not** a zero-finding clearance.

Final independent complete-diff review of this resulting HEAD remains pending.

## Round 13

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `9d416784ec12f5819ec245d62fdbe5dd490a09a3`.
- One actionable finding: an oversized file response with a declared `Content-Length` was rejected without cancelling its unread body. Remote reads now cancel the body on early content-type, length-validation, and declared-overflow rejection. A regression exercises both declared and streamed overflow and verifies cancellation.
- Validation after fix: `bun run check` passed; full `bun run test` passed 62 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 13 is **not** a zero-finding clearance.

Final independent complete-diff review of this resulting HEAD remains pending.

## Round 14

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `8073a3d44155b83c85cd3b6a23660b867ae917e5`.
- Two actionable findings: public direct `submitCreate` could remain pending while capability lookup or image preparation hung after abort/close, and a direct operation handle discarded its terminal result after the first observation. Direct preflight now races cancellation before dispatch, and operation handles cache terminal success or definitive failure for their process lifetime. Regressions cover stalled preflight and repeated observation without provider discovery.
- Validation after fixes: `bun run check` passed; full `bun run test` passed 64 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 14 is **not** a zero-finding clearance.

Final independent complete-diff review of this resulting HEAD remains pending.

## Round 15

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `40b50e8694f3fe0f501bda0e27b28229ef77f71d`.
- Two actionable findings: the public `submitCreate`/`submitExec` types and namespace wrappers did not expose their implemented cancellation signal, and fake direct file reads accepted unvalidated base64 and returned an untyped missing-file error. Submission interfaces and wrappers now forward signals. The fake client validates its file response and uses a shared SPI read error that the direct SDK maps to `NOT_FOUND` or `INVALID_RESPONSE`.
- Validation after fixes: `bun run check` passed; full `bun run test` passed 65 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 15 is **not** a zero-finding clearance.

Final independent complete-diff review of this resulting HEAD remains pending.

## Round 16

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `28ec91c1429395dc44c26c609f5b7f8c2aeb38df`.
- One actionable finding: a pre-aborted signal passed to direct or remote `submitExec`, or remote `submitCreate`, could dispatch before `awaitSubmission` rejected. All three entry points now reject before provider/HTTP mutation. Tests verify no invocation or HTTP POST occurs.
- Validation after fix: `bun run check` passed; full `bun run test` passed 65 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 16 is **not** a zero-finding clearance.

Final independent complete-diff review of this resulting HEAD remains pending.

## Round 17

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `4ebd5f390e4f39994b1880f692f7cb907549ee58`.
- Two actionable findings: remote `submitExec` sent input without local contract parsing, and direct `inspect` trusted an unvalidated driver observation. Remote exec now parses `ExecRequest` before dispatch; direct inspect parses `SandboxObservation` before exposing state. Regressions cover invalid remote exec and malformed direct state.
- Validation after fixes: `bun run check` passed; full `bun run test` passed 66 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 17 is **not** a zero-finding clearance.

Final independent complete-diff review of this resulting HEAD remains pending.

## Round 18

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `d4a91f395e149f53baf0231e518410deff5eb83f`.
- Reviewed HEAD: `3a7527e067101f87c54bc8e5635d548e0461d68c`.
- One actionable finding: malformed runtime create input could be dereferenced before validation in both backends. Shared strict create validation now runs before reading environment fields or dispatching. Tests verify invalid input causes `INVALID_ARGUMENT` and no provider/HTTP mutation.
- Validation after fix: `bun run check` passed; full `bun run test` passed 66 tests with one MySQL 8.4 skip and zero failures, including browser E2E. Round 18 is **not** a zero-finding clearance.

Final independent complete-diff review of this resulting HEAD remains pending.

## PR #6 GitHub feedback repair (pre-integration)

- GitHub P1 `discussion_r4112470318`: remote operation observation and result decoding could lose the recovery reference after service admission. Post-admission poll and follow-up read failures now raise `OutcomeUnknownError` with the sealed operation reference. Confirmed failed operations, nonzero/unknown exit status, and applied output-unavailable outcomes retain their semantic errors. Regressions cover a failed poll, a succeeded create followed by a failed sandbox fetch, and a succeeded exec followed by a failed execution fetch; recovery uses reads only and mutation counts remain one.
- GitHub P2 `discussion_r4112470323`: imported direct references could retain or forward nested extras stripped by validation. Both backends now use detached validated references, and operation handles seal nested reference data against later caller changes. Regressions verify nested secrets are absent from serialization and provider observation, remote scope mutation cannot redirect recovery, and strict remote service fields reject extras.
- Pre-integration validation: focused SDK tests 26/26 passed; `bun run check` passed; full `bun run test` passed 69 tests with one MySQL 8.4 skip and zero failures, including browser E2E.
- Final parent rebase and independent complete-diff zero-finding review are pending before PR #6 is updated.
