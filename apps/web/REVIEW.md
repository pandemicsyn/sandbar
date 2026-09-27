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

## Round 8

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `3913213ca9a43e8dab8ca70dbff3c562abcc8f6b`.
- Reviewed HEAD: `c68bec9316312cdee5ff66f0514b38774174daf3`.
- Finding: skip-link targets were not focusable, so keyboard focus could remain on the link instead of moving to the main content.
- Fix: both Projects and the authenticated shell main landmarks have `tabIndex={-1}`. Chromium E2E activates each skip link and verifies `document.activeElement.id` is `main-content`.
- Validation after fix: `bun run check && bun run build && bun run test` passes (40 passed, 1 local MySQL skip, 0 failed, 1331 assertions; Chromium E2E has 30 assertions); `git diff --check` passes. Final zero-finding review remains pending.

## Round 9

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `3913213ca9a43e8dab8ca70dbff3c562abcc8f6b`.
- Reviewed HEAD: `66432c72cba31ba0468419b018cf1e68afcfa825`.
- Finding: ProjectLayout loading, error, and unavailable states lacked the skip link's focusable main target.
- Fix: each fallback renders a focusable `<main id="main-content">`; Chromium E2E navigates directly to an unavailable project and verifies keyboard focus reaches the landmark.
- Validation after fix: `bun run check && bun run build && bun run test` passes (40 passed, 1 local MySQL skip, 0 failed, 1332 assertions; Chromium E2E has 31 assertions); `git diff --check` passes. A fresh zero-finding review remains pending.

## Round 10

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `3913213ca9a43e8dab8ca70dbff3c562abcc8f6b`.
- Reviewed HEAD: `464e4bd9b1c81d18f25ec02ea343952dd7408023`.
- Finding: the authenticated not-found route lacked the focusable main target for the global skip link.
- Fix: the not-found view renders a focusable `<main id="main-content">`; Chromium E2E navigates to an unmatched route and verifies focus reaches it.
- Validation after fix: `bun run check && bun run build && bun run test` passes (40 passed, 1 local MySQL skip, 0 failed, 1333 assertions; Chromium E2E has 32 assertions); `git diff --check` passes. A fresh zero-finding review remains pending.

## Round 11

- Reviewer: independent subagent, `gpt-6-luna`, high reasoning; read-only.
- Base: `3913213ca9a43e8dab8ca70dbff3c562abcc8f6b`.
- Reviewed HEAD: `11d8de73cdf4ad339621b5e783ddb7a3e9431523`.
- Finding: changing inputs after an accepted invocation silently minted a fresh key and bypassed the explicit new-attempt warning.
- Fix: all intent mismatches now stop before dispatch until the operator confirms a new attempt; the clear action refreshes the UI immediately. Chromium E2E changes a label after an accepted create, verifies no new provider effect, then explicitly starts a new attempt.
- Validation after fix: `bun run check && bun run build && bun run test` passes (40 passed, 1 local MySQL skip, 0 failed, 1334 assertions; Chromium E2E has 33 assertions); `git diff --check` passes. A fresh zero-finding review remains pending.

## Final clearance

The initial PR base was `3913213ca9a43e8dab8ca70dbff3c562abcc8f6b` on reviewed contracts/fake parent `8bf25d4f32c63d6f73d897fdddd5ace6756b58aa`. Control PR #3 was review-cleared at that SHA. The UI offers exact byte downloads for command stdout and stderr alongside UTF-8 display text. The original PR was created after a fresh independent reviewer reported zero actionable findings on the unchanged base and HEAD.

## PR feedback repair

- GitHub review `discussion_r4112123977`: a successful file write cleared React's selected `File` while the native file input kept its value. The upload handler now clears both only after an accepted result. Chromium E2E checks the native value is empty, explicitly starts a new file-write attempt, selects the same local file again, and verifies a second fake-provider effect at a new remote path.
- GitHub review `discussion_r4112123982`: a standalone browser test could reuse stale `apps/web/dist`. E2E setup now runs the web build on every invocation before starting the service and browser. The new native-input assertions exercise behavior from the rebuilt source.
- Focused validation on repair commit `e80ae7c`: web TypeScript check and standalone Chromium E2E pass (1 test, 36 assertions); `git diff --check` passes. Full validation and an independent review of the final parent-based diff remain pending.

## PR feedback review, preparent checkpoint

- Reviewer: independent read-only subagent, `gpt-6-luna`, high reasoning.
- Base: `3913213ca9a43e8dab8ca70dbff3c562abcc8f6b`; reviewed HEAD: `8e885ad456f197c03900d7d1ad4e4ef3f33dcc25`.
- Complete diff: `/private/tmp/sandbar-web-pr4-repair-preparent.diff` (3,553 lines).
- Finding: zero remaining actionable findings at this checkpoint. Reviewer inspected the UI, API client, invocation recovery, styles, CI changes, and browser E2E. The final parent rebase and final review are still required before updating PR #4.

## Final foundation tooling preparation

- Foundation's reviewed `b4ca229` adds repository-wide Oxlint anti-slop rules and Oxfmt. A disposable copy of that commit with the current web files overlaid identified the web-owned violations without rebasing onto an intermediate control commit.
- Repair commit `7337da4` applies the formatter, accepts typed invocation and fake-seed inputs, parses saved invocation records and caught errors with Zod, parses Fleet search inputs with the shared query schema, and replaces conditional empty spreads and filter/map chains. The existing accepted-upload DOM reset remains intact.
- Validation at this checkpoint: disposable overlay `bun run lint` and `bun run format:check` pass; actual web branch TypeScript check and standalone Chromium E2E pass (1 test, 36 assertions); `git diff --check` passes. Final stacked rebase, full checks, and independent review remain pending.

## Tooling checkpoint review

- Reviewer: independent read-only subagent, `gpt-6-luna`, high reasoning.
- Base: `3913213ca9a43e8dab8ca70dbff3c562abcc8f6b`; reviewed HEAD: `d9027fa80efced248e0e8ada03900f4938112b0f`.
- Complete diff: `/private/tmp/sandbar-web-pr4-tooling-preparent.diff` (3,565 lines).
- Finding: zero remaining actionable findings in the web implementation and tests, including lint adaptation, Fleet search parsing, file-input reset, and fresh-build E2E. Final parent rebase and final independent review remain required.

## Merged-parent integration checkpoint

- Rebased the web branch onto merged `main` at `1e1acd832f6c9b8dd075bc78ea95c672e75467a2`, which includes the reviewed durable-control branch. The CI conflict resolution preserves foundation's lint, format, typecheck, test, and build gates and installs Chromium from `apps/web`.
- Execution display now decodes the exact `stdoutBase64` and `stderrBase64` contract fields as UTF-8, replacing invalid sequences for display; download uses the original bytes. Chromium E2E checks both display and byte-exact download for an invalid UTF-8 fixture.
- Validation: `bun install --frozen-lockfile`, `bun run lint:fix`, `bun run format`, `bun run lint`, `bun run format:check`, `bun run check`, `bun run build`, `bun run test`, and `git diff --check` pass. Full test result: 82 passed, 5 MySQL tests skipped without a local MySQL test URL, 0 failed, 1,823 assertions. Chromium E2E rebuilt the current web assets and passed with 38 assertions.
- A fresh read-only independent review of the complete `main...HEAD` diff is required before PR #4 is updated. The final exact base/HEAD review record is kept locally alongside the PR provenance.

## Current-head GitHub review follow-up

- A second independent read-only gpt-6-luna/high complete-diff review reported zero actionable findings on merged main 1e1acd832f6c9b8dd075bc78ea95c672e75467a2 to web HEAD 61fc8cfb363fdf4aaf65fe96f44e30add3e8227d. The branch was pushed and PR #4 retargeted to main.
- Both original GitHub review threads were answered with fix/test evidence and resolved. The current-head GitHub Codex review then found two supported-path issues: an operation polling refresh discarded same-key loaded data and stopped polling after a transient failure, and Fleet's combined URL-filter validation cleared valid search text when state was invalid.
- The manager approved narrow fixes after reviewing concrete paths and impact. Same-key resource refreshes now retain loaded data; Operation detail keeps its Refresh action and shows transient errors while polling continues, and an initial failed load offers Retry. Route-key changes still hide previous-key data. Fleet validates each existing URL filter independently through its contract field schema.
- Chromium E2E injects an initial operation GET failure, retries into an in-progress view, injects one failed poll, then observes completion without reload. It also opens a shared Fleet URL with valid q and invalid state, checking that the API request retains q and omits state.
- Validation after fixes: lint, format check, all package typechecks, build, full tests, and diff check passed. Full suite: 82 passed, 5 local MySQL skips, 0 failed, 1,831 assertions; Chromium E2E rebuilt current assets and passed with 46 assertions. A fresh independent complete-diff review of the resulting exact base/HEAD is required before another push.
- PR CI on the earlier HEAD had one control-owned crash test failure on the first pull-request run; the unchanged-HEAD rerun passed all gates, as did the push event. No backend code was changed.

## Further GitHub review follow-up

- GitHub Codex posted three concrete P2 comments against the previous reviewed head: terminal execution detail fetches had no independent retry, Fleet's relative freshness age froze while the page remained idle, and successful file reads accepted unvalidated response headers and bytes.
- The manager approved three minimal repairs after reviewing the comments and code. Operation detail now offers Retry execution details, which reruns only the read and retains operation identity and the existing cross-route guard. Fleet shows the absolute observed timestamp, with an unknown fallback. File download validates the existing FileReadHeaders contract, rejects missing or malformed length, and compares actual blob size before accepting the file.
- Chromium E2E fails the first terminal execution read and retries to the original captured output without another mutation; checks the Fleet timestamp element; rejects successful HTML and mismatched-length file responses without a download, then downloads the valid binary response.
- Validation after fixes: lint, format check, all package typechecks, build, full tests, and diff check passed. Full suite: 82 passed, 5 local MySQL skips, 0 failed, 1,835 assertions; Chromium E2E rebuilt current assets and passed with 50 assertions. A fresh independent complete-diff review is required before another push.

## Browser test sequencing repair

- On reviewed HEAD bed5cad, push CI passed but pull-request CI failed in the new operation-read regression. The first injected 503 could be consumed by an in-flight poll already active before the test reloaded the operation route, so the test looked for an initial-load Retry button while the UI correctly showed a transient error with retained details.
- The manager approved a test-only sequencing fix. The browser now leaves Operation detail and waits for Fleet before installing the interceptor, then navigates directly to the operation URL. It still checks the initial-load Retry, a later failed poll with retained details/Refresh, and automatic recovery without reload.
- Rebuilt Chromium regression, lint, format check, all package typechecks, build, full suite, and diff check pass after the repair: 82 passed, 5 local MySQL skips, 0 failed, 1,831 assertions; Chromium E2E has 46 assertions. No application or backend code changed in this repair. Fresh independent complete-diff review remains required before pushing.

## Merged-parent review round 1

- Reviewer: independent read-only subagent, `gpt-6-luna`, high reasoning.
- Base: `1e1acd832f6c9b8dd075bc78ea95c672e75467a2`; reviewed HEAD: `1a4537f2b6babc79d39f14089a8bd0e559b40500`.
- Complete diff: `/private/tmp/sandbar-web-pr4-final-main.diff` (3,581 lines).
- Finding: a 500 response from Fleet's provider-connection list was presented as an empty verified-connection list, hiding the fetch error and blocking creation without a retry path. The manager approved a narrow fix after the concrete supported-path reproduction was reported.
- Fix: Fleet now renders the connection error and a retry action before the successful-empty warning; loading also keeps the create form gated. Chromium E2E fails the first list request after a verified connection exists, checks the error and absence of the misleading warning, then retries and sees creation available without navigation.
- Validation after fix: `bun run lint`, `bun run format:check`, `bun run check`, `bun run build`, `bun run test`, and `git diff --check` pass; 82 tests passed, 5 local MySQL skips, 0 failed, 1,826 assertions. Chromium E2E passed with 41 assertions after rebuilding current assets. Another independent complete-diff review is required before the PR update.
