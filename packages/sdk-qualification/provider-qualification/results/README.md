# Reviewed provider results

Keep one reviewed summary per provider. Retain tested configuration, exact source/native/runtime provenance, timestamp, cleanup and an evidence reference. Git history preserves earlier versions. Do not commit native logs, credentials, account/resource IDs or recovery references; private JUnit, contexts and custody stay outside the repository.

New tests use ordinary Bun JUnit and the thin offline importer documented in the parent README. A clean exact revision may be tested on a branch or after merge using the same invocation. A reviewed unchanged path retains its original provenance across merge; do not relabel historical results as current-head or Bun runs. Skipped is not passed, missing access is not unsupported, and unconfirmed cleanup or close cannot produce a passed claim. Fixture/packed evidence remains separate from live evidence.

The recorded Daytona snapshot/fresh-process and volume CRUD acceptance at `9a6c1c1` used the prior executor. The new Bun path has offline validation only. Preserve original E2B uncertain volume custody and historical results exactly; this migration authorizes no paid rerun.
