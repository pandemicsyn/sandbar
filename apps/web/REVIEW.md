# Web and end-to-end review record

This report records independent static reviews for the management UI and browser end-to-end slice. The branch is stacked on `codex/durable-control`; review clearance applies only to the exact final base and HEAD hashes listed below.

## Round 1

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `cbc159ec9a571fe000789ba3b9d14b88f4b93e99`.
- Reviewed HEAD: `95fd21cfca1e259960e1c2178d2e5f6d31700042`.
- Findings: (1) `useResource` could show prior sandbox/operation data while route params changed, enabling actions against the new ID; (2) the Projects page lacked the authenticated skip-link target; (3) file upload read arbitrarily large local files before the service's 1 MiB bound.
- Fixes: resource state is keyed to route dependencies and actions wait for matching data; Projects renders a `main` landmark with `id="main-content"`; upload checks `file.size` before `arrayBuffer()` and reports a bounded error. Browser E2E now checks the oversized-file rejection and no fake file-write effect. CI installs the pinned Playwright browser from `apps/web`.
- Validation after fixes: `bun run check`, `bun run build`, and `bun run test` passed locally (20 passed, 1 MySQL test skipped without a local test URL; Chromium E2E included). MySQL 8.4 conformance is owned and run by the durable-control task.

## Browser response recovery follow-up

- A review follow-up identified that the browser generated a new invocation key when a lost HTTP response led the user to retry from a remounted route. Each effecting form now retains its unresolved key and a hash of the original intent. A retry with changed inputs is stopped before dispatch; starting a separate attempt requires an explicit duplicate-effect warning.
- The browser test drops the first create response after Sandbar accepts it, rejects a changed-label retry without another fake effect, navigates away and back, then recovers the original operation with the same key. It also retains the prior provider lost-after-effect and restart scenarios.
- Local verification: `bun run check && bun run build && bun run test` passes (20 passed, 1 MySQL test skipped without a local test URL, 667 assertions; Chromium E2E has 21 assertions). Independent full-diff clearance remains pending after dependency rebase.

## Round 2

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `cbc159ec9a571fe000789ba3b9d14b88f4b93e99`.
- Reviewed HEAD: `566d3b33d0c03c90b7e3e6be7bbb0e6444f0f68d`.
- Findings: (1) the unresolved invocation key existed only in memory, so a reload could make an accepted effect impossible to recover without a duplicate; (2) file download bypassed shared session-expiry handling on HTTP 401.
- Fixes: persist only key and intent hash in browser local storage before dispatch, and retain it until an accepted response is parsed; use the same session-expiry notification for file downloads. The browser test now reloads after a dropped accepted response and checks a 401 download returns to sign-in.
- Validation after fixes: `bun run check && bun run build && bun run test` passes (20 passed, 1 local MySQL skip, 0 failed, 667 assertions). A final dependency rebase requires another run and review.

## Final clearance

Pending a fresh independent full-diff review after the final dependency rebase. No pull request will be created until a reviewer reports zero actionable findings on the unchanged final base and HEAD.
