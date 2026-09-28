# Provider results

Keep one reviewed summary per provider: `daytona.json` and `e2b.json`. Update the appropriate file when intentionally publishing qualification evidence. A file may contain multiple scenarios or configurations; Git history retains earlier versions.

Retain scenario status, tested configuration, exact revisions, versions, timestamp, cleanup status and evidence reference. Do not commit debugging runs, error messages, byte dumps, native responses, credentials, resource IDs or recovery references. Detailed diagnostics and cleanup ledgers stay in the private operator directory outside the repository.

The docs matrix uses these summaries. Only merged-source live runs can certify support; successful unmerged diagnostic runs may be summarized in the PR discussion without being promoted to certification.
