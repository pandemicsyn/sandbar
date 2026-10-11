# Native boundary provenance

Audited October 11, 2026 against the published `@vercel/sandbox@3.6.1` archive, downloaded without executing package code:

- Archive: https://registry.npmjs.org/@vercel/sandbox/-/sandbox-3.6.1.tgz
- Integrity: `sha512-U6dwyadp2SmW/M96W2Bb3UjIql6TOOYwu9McUIwob209pj0A3ks/wKrMv7lCE7INx50J5zOpqLhMOnFa+Yodlg==`
- Inspected emitted `api-client/api-client.js`, `validators.js`, `base-client.js`, `with-retry.js` and `utils/network-policy.js`.
- Upstream reference: https://github.com/vercel/sandbox/tree/31244aa3280dc3fdca0680933f85971570d73d2d
- Implementation brief: https://github.com/pandemicsyn/sandbar/issues/28

`@sandbar-sdk/vercel` implements the public `@sandbar-sdk/adapter` API and owns HTTP construction; it does not import SDK internals or install the native SDK. Every request uses the fixed `https://vercel.com/api` origin, explicit team routing, redirects disabled and one fetch dispatch. Injectable transports are trusted host code and must not retry mutations.

Creation uses `/v3/sandboxes`; session detail/stop, command detail/logs and binary filesystem routes use `/v2/sandboxes/sessions/{id}`. Project ownership reads use `/v2/teams/{teamId}` and `/v2/projects/{projectId}`. Collection queries use `project`, rather than uniformly substituting `projectId`. Reopened IDs are checked against the project's session collection. No named lookup, resume, renewal, or DELETE request is made.

This is a version-sensitive source-derived REST boundary, without an independently established public stability guarantee. Published 3.6.1 ordinary logs are strings; binary finite stdin is absent there even though the inspected upstream revision declares the same version and adds stdin support. This implementation does not rely on stdin. A newer SDK must be inspected as a published artifact before that assumption changes.

Guest capture launches user argv exactly once with Node 24. Only the helper's private receipt path enters text logs; user stdout/stderr remain bytes, bounded together before base64 encoding and binary-file retrieval. Malformed/incomplete receipts fail closed. Read-only recovery never reinstalls or launches the helper. Receipts remain until disposable-session teardown. Acknowledged command identity remains saved if retrieval fails; a lost initial command acknowledgement remains unknown. Local abort does not establish remote termination.

Only `stopped` and `aborted` are treated as terminal compute evidence; `failed`, absence and response loss do not certify cleanup. Reusable-name deletion has no proven generation precondition. Named metadata remains retained. No live observations are implied by this audit or deterministic fixtures.
