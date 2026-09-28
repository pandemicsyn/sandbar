# E2B write failure diagnosis (offline)

The two dated live reports remain evidence for their original SDK and harness commits. This diagnosis and instrumentation change is **offline evidence**, not a live pass or a new provider run.

The diagnostic live run reported a write-stage `OutcomeUnknownError`: `E2B written bytes differ from the submitted content`. For overwrite, the adapter reaches that observation only after its native write path throws and returns pending. That path includes both `Sandbox.connect` and `sandbox.files.write`. The old catch discarded the original exception. The later readback mismatch therefore cannot identify the original native failure or establish that upload succeeded.

A deterministic fixture reproduces the sequence: seed `[0,255,1,128]`, throw before replacing it with `[2,254,0]`, then observe old content. The injected HTTP 500 is a test input, not a claim about either live run. Pinned SDK multipart loopback checks also pass; they do not establish the live service's behavior.

## Error preservation

The native transport now classifies connection versus upload failures per call. It retains an allowlisted error class and an optional validated HTTP status. The pinned SDK's public logger exposes numeric response status even when an upload exception lacks `statusCode`; the collector discards every other logger argument. Recovery retains only this classification, never native messages, bodies, URLs, trace IDs or stacks.

The optional classification extends existing write tokens. Recovery accepts older tokens without it. Readback mismatch reports expected and actual lengths, truncation and digest-match facts alongside the original classification. A readback failure retains the original classification too. A matching readback still completes a write whose acknowledgement was lost. Observation never resubmits the write.

The qualification harness separately attempts one bounded public read of its own tiny fixture after an overwrite exception. It captures actual bytes when available, retains the write exception as primary, and keeps no-clobber blocked. A failed diagnostic read does not replace the write failure or prevent teardown.

## Remaining uncertainty

The original native class/status and connect/upload stage were not retained in the two live runs and cannot be recovered from their reports. This change fixes that loss of evidence; it does not prove or repair the underlying native failure. An authorized diagnostic run of the merged change is needed to identify that failure. No further live run was made for this change.
