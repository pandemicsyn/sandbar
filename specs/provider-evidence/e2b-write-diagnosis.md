# E2B write failure diagnosis

The two dated live reports remain evidence for their original SDK and harness commits. The initial reproduction and instrumentation checks are offline evidence. After the user requested live diagnosis, two diagnostic runs used the unmerged fix and are recorded separately below; they do not certify the support matrix.

The diagnostic live run reported a write-stage `OutcomeUnknownError`: `E2B written bytes differ from the submitted content`. For overwrite, the adapter reaches that observation only after its native write path throws and returns pending. That path includes both `Sandbox.connect` and `sandbox.files.write`. The old catch discarded the original exception. The later readback mismatch therefore cannot identify the original native failure or establish that upload succeeded.

A deterministic fixture reproduces the sequence: seed `[0,255,1,128]`, throw before replacing it with `[2,254,0]`, then observe old content. The injected HTTP 500 is a test input, not a claim about either live run. Pinned SDK multipart loopback checks also pass; they do not establish the live service's behavior.

## Error preservation

The native transport now classifies connection versus upload failures per call. It retains an allowlisted error class and an optional validated HTTP status. The pinned SDK's public logger exposes numeric response status even when an upload exception lacks `statusCode`; the collector discards every other logger argument. Recovery retains only this classification, never native messages, bodies, URLs, trace IDs or stacks.

The optional classification extends existing write tokens. Recovery accepts older tokens without it. Readback mismatch reports expected and actual lengths, truncation and digest-match facts alongside the original classification. A readback failure retains the original classification too. A matching readback still completes a write whose acknowledgement was lost. Observation never resubmits the write.

The qualification harness separately attempts one bounded public read of its own tiny fixture after an overwrite exception. It captures actual bytes when available, retains the write exception as primary, and keeps no-clobber blocked. A failed diagnostic read does not replace the write failure or prevent teardown.

## Live diagnosis on the unmerged fix

The user explicitly requested running E2B and finding the cause. Two finite diagnostic runs used clean SDK/harness commit `d934bf09ca9308fca051a16043409c0c43fe480e`, pinned E2B SDK 2.51.0, Bun 1.3.14 and deployed envd 0.6.10. Each created one public `base` sandbox with native 300-second lifetime, no builds, and confirmed owned termination and close. Durations were 4.341 and 8.549 seconds. The second run captured the upload response's bounded, sanitized message and Linux facts, and added a private-directory control using public SDK calls. The normal merged-source qualification gate was unchanged.

[Sanitized diagnostic record](diagnostics/e2b-2026-09-28-root-cause.json) records exact commit, driver SHA-256, checks and cleanup. These temporary drivers used the existing public factory, lifecycle and pre-dispatch private ledger. This artifact is outside qualification `results/` and does not generate support-matrix rows. No native IDs, credentials, raw responses or private recovery references are included.

### Confirmed failure and cause

- Connection succeeded; upload returned HTTP 500 with native `SandboxError`.
- Server message: `error opening file: open /tmp/sandbar-qualification-[REDACTED]: permission denied`.
- Readback retained `[0,255,1,128]` (four bytes), instead of `[2,254,0]` (three bytes). No truncation was reported.
- The sandbox reported caller UID 1000, envd UID 0, `fs.protected_regular=2`, and root-owned `/tmp` mode 1777.
- The same four-to-three-byte overwrite succeeded under a newly created private directory, returning `[2,254,0]`.

The [envd 0.6.10 upload source](https://github.com/e2b-dev/runtime/blob/04317f8a2270ba7c5d4991937c34c5b388a4bd07/packages/envd/internal/api/upload.go) changes existing files to the requested user's ownership before opening them with `O_WRONLY | O_CREATE | O_TRUNC`. The root daemon's `O_CREAT` open is rejected for an existing user-owned file in root-owned sticky `/tmp` when [Linux protected_regular](https://docs.kernel.org/admin-guide/sysctl/fs.html#protected-regular) is enabled. The live error, kernel settings and successful private-directory control support this mechanism. The envd version string does not establish the deployed binary's build SHA.

This is a native E2B/envd permission failure for overwrite in sticky `/tmp`, compounded by Sandbar discarding the original exception. It is not a binary-encoding or missing-truncation failure. The Sandbar change preserves classification and readback evidence; it does not repair envd or claim general overwrite support. No-clobber remained blocked after the failed overwrite. No security setting was changed and no overwrite workaround or hidden retry was added.


## Documentation-led correction and retest

The user directed a fresh review of E2B's documentation before fixing and retesting. The [default-user/workdir guide](https://docs.e2b.dev/template/user-and-workdir) specifies `user` and `/home/user`; the [upload quickstart](https://docs.e2b.dev/quickstart/upload-download-files) writes in `/home/user`. The [pinned 2.51.0 filesystem reference](https://docs.e2b.dev/sdk-reference/js-sdk/v2.51.0/sandbox-filesystem) accepts `Blob` and states that `files.write` overwrites existing files. Sandbar already calls that native API with an accepted binary type and the default user. The docs do not prohibit `/tmp`, so the observed sticky-directory behavior remains a native limitation rather than proof of an invalid API call.

The E2B baseline now explicitly selects `/home/user` instead of assuming shared sticky `/tmp` behaves like the documented user workspace. The private ledger and public configuration record the selected file root. The generated table groups file scenarios by root; a home-directory pass cannot supersede a `/tmp` failure. Historical records are unchanged and retain their path evidence in their dated handoffs.

The user-requested retest used clean unmerged commit `966dc4820fa2e94fe55d8ffdf411058b9e43f1a5`, one public `base` sandbox, native 300-second lifetime and no build. **All 13 baseline checks passed**, including binary write/read, shorter overwrite and no-clobber conflict. Connect/create/inspect, argv/shell/nonzero, inventory, destroy confirmation and close passed too. Elapsed time was **7.467 seconds**, envd **0.6.10**, and owned cleanup was confirmed. OCI builds were not run.

[Sanitized retest evidence](diagnostics/e2b-2026-09-28-docs-workflow.json) records exact commit, temporary driver hash, documentation sources, file root and cleanup. This unmerged diagnostic sits outside certification results. The test-workspace correction does not modify provider write behavior, elevate the user, add staging/retries, change security settings or claim arbitrary-path overwrite support. A merged-source certification remains a separate gate.
