# Reviewed provider results

Keep one reviewed summary per provider. Retain tested configuration, exact source/native/runtime provenance, timestamp, cleanup and an evidence reference. Git history preserves earlier versions. Do not commit native logs, credentials, account/resource IDs or recovery references; private JUnit, contexts and custody stay outside the repository.

New tests use ordinary Bun JUnit and the thin offline importer documented in the parent README. A clean exact revision may be tested on a branch or after merge using the same invocation. A reviewed unchanged path retains its original provenance across merge; do not relabel historical results as current-head or Bun runs. Skipped is not passed, missing access is not unsupported, and unconfirmed cleanup or close cannot produce a passed claim. Fixture/packed evidence remains separate from live evidence.

Earlier executor evidence retains its recorded revisions. The Bun suites now also have scoped live evidence, including #68 at `3188e33` and selected-volume restore in #69 at `5911ccc`; use the maintained per-provider records for exact cases and configuration. Preserve original E2B uncertain volume custody and prior failed/blocked records. None of these results authorizes a paid rerun.
