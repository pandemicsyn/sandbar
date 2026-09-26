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

## Round 3

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `cbc159ec9a571fe000789ba3b9d14b88f4b93e99`.
- Reviewed HEAD: `4872cd24101503fcfd7fd0f522ef2e0a04df7097`.
- Finding: execution output was not keyed to the current operation, so route changes or out-of-order execution fetches could show a prior command's stdout, stderr, and exit code under another operation.
- Fix: key execution state by project, operation, and execution IDs, clear it on relevant updates, and ignore stale fetch completion after effect cleanup.
- Validation after fix: `bun run check && bun run build && bun run test` passes (20 passed, 1 local MySQL skip, 0 failed, 667 assertions).

## Recovery lookup integration

- Control added a read-only, project-scoped lookup from invocation key and endpoint identity to the accepted operation. The web UI now offers a recovery action for unresolved create, exec, destroy, and file-write submissions without storing command text or file contents in browser storage.
- Browser E2E drops an accepted exec response, reloads the page, uses the lookup to open the original operation, and verifies its ID and provider effect count.
- Integration checkpoint: rebased onto control `b17cca30a9f730ad25aa8088a4e1741f18e947e7` and ran `bun run check && bun run build && bun run test` successfully (27 passed, 1 local MySQL skip, 0 failed, 1239 assertions). The browser test exercises the real lookup route. Contracts and control parent reviews are still in progress; final dependency rebase and independent web review remain required.

## Round 4

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `b17cca30a9f730ad25aa8088a4e1741f18e947e7`.
- Reviewed HEAD: `4dbb184b0b3d0bfe2c095d6ca8287bff494ff2aa`.
- Finding: two tabs could race during invocation hashing and local-storage admission, mint different keys for the same effect scope, and lose one recovery identity.
- Fix: hold a browser Web Lock per action scope while reading, storing, submitting, and clearing the invocation identity. An explicit reset also waits for the lock. Browsers without Web Locks fail before effect dispatch.
- Validation after fixes: with control's stable session CSRF and reviewed contracts parent integrated at base `2f9a3fb8b451e00f83f88f8848402ef352e30cea`, `bun run check && bun run build && bun run test` passes (36 passed, 1 local MySQL skip, 0 failed, 1302 assertions). The two-tab held-response test passes with one provider effect and the original operation ID. Control's final review is still running; a subsequent parent change requires a fresh web rebase and review.

## Round 5

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `2f9a3fb8b451e00f83f88f8848402ef352e30cea`.
- Reviewed HEAD: `736e71ad83b2cdd7376f0c819a812d83d515bd08`.
- Findings: (1) a 401 sign-out response left the authenticated shell visible because `logout()` bypassed session-expiry notification; (2) each Fleet search keystroke pushed a history entry.
- Fixes: 401 sign-out now clears session state and returns to sign-in; Fleet filter updates replace the current history entry. Browser E2E covers an expired session at sign-out and verifies Back leaves the filtered Fleet.
- Validation after fixes: `bun run check && bun run build && bun run test` passes (36 passed, 1 local MySQL skip, 0 failed, 1302 assertions). Final parent review and any resulting rebase remain pending.

## Round 6

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `480cecc7e86f16aa8aba5df21cc0b33934515e91`.
- Reviewed HEAD: `3a54cb234ea8a5edfad52229bebeec8b4667b61b`.
- Finding: lookup read the invocation key outside the per-scope Web Lock, then cleared it after lookup; a queued retry could mint a new key and duplicate the accepted effect.
- Fix: lookup now holds the lock through the read and response, marking the record accepted. Accepted records retain their key as an idempotent tombstone. Same inputs reopen the existing operation; explicitly starting a new attempt or changing accepted inputs creates a new intent. The browser E2E holds an exec lookup while another tab queues a retry and verifies both open the original operation with one provider effect.
- Validation: web check/build and Chromium E2E pass (27 assertions). Full workspace validation and final parent rebase remain pending.

## Round 7

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `480cecc7e86f16aa8aba5df21cc0b33934515e91`.
- Reviewed HEAD: `a5343025baccad4931dc20ac52168e6e76d75ee6`.
- Findings: zero remaining actionable issues on the complete web diff at this checkpoint.
- Validation: web check/build and Chromium E2E pass; the full suite had one intermittent control-owned cleanup assertion that passed on focused rerun. Control is fixing that test. The parent branch is still changing, so a final fresh review is required after rebase.

## Final clearance

Current integration checkpoint: base `480cecc7e86f16aa8aba5df21cc0b33934515e91` on reviewed contracts/fake parent `8bf25d4f32c63d6f73d897fdddd5ace6756b58aa`. Control's independent review and a fresh web full-diff review are pending. No pull request will be created until the reviewer reports zero actionable findings on the unchanged final base and HEAD.
