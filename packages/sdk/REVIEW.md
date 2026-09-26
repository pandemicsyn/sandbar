# SDK review record

## Round 1

- Reviewer: independent `gpt-6-luna`, high reasoning, read-only.
- Reviewed base: `1577b8f4dcd57547517422b19cf4cd3b9e6a0bbc` (`codex/portable-core`).
- Reviewed HEAD: `0573cf8eb900048f3623a8002b79fe38bfebd97a` (`codex/typescript-sdk`).
- Four actionable findings: remote output could exceed request bound; recovered remote executions lacked complete identity/status/output checks; direct oversized writes could yield unrecoverable references; remote bearer tokens could travel over non-loopback HTTP.
- Fixes: bounded combined remote output before return, correlated recovered executions and preserved unknowns, rejected direct writes above 1 MiB before submission, and required HTTPS except literal loopback HTTP. Added focused tests for the latter three. Round 1 is **not** a zero-finding clearance.
- Validation after fixes: `bun run check` passed; `bun test packages/sdk/src/sdk.test.ts` passed 7/7.

Final complete-diff review and parent integration remain pending.
