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
