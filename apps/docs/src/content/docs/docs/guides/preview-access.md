---
title: Preview access
description: Resolve native HTTP access to an existing sandbox service.
---

Use `await box.preview(3000)` to obtain access to an HTTP service already running in the sandbox. Setup selects the native access mode once:

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const client = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    preview: { access: "protected" }, // default
  }),
);
const box = await client.sandboxes.create({
  environment: Image.prepared("existing-server-snapshot"),
  networkPolicy: "blocked",
});
try {
  const preview = await box.preview(3000);
  const response = await fetch(preview.url, {
    headers: preview.access === "protected" ? preview.headers : undefined,
  });
  if (!response.ok) throw new Error("Service unavailable or not ready");
  console.log(await response.text());
} finally {
  await box.destroy();
  await client.close();
}
```

The prepared image must already start the server. Preview access does not start one, wait for readiness, resume compute, extend its lifetime, replace it or change outbound networking. An available URL can still return a proxy error or connection refusal. Ports must be integers from 1 through 65535. `preview(port, { signal })` cancels local waiting; it never stops a remote service. Sandbar bounds lookup waiting to 30 seconds.

A protected result contains `url` and `headers` for an HTTP client. **Daytona's header token grants sandbox-wide access, including terminal/toolbox command execution and filesystem access.** Keep it in your own client and do not share it as a viewing grant. A browser cannot supply these headers by merely opening the URL. Native standard tokens cannot be individually revoked; stop/start rotates them, while pause/resume retains them. Native GET can activate the requested preview route. Sandbar first verifies private visibility, identity and running state, and never flips visibility during lookup. Public Daytona setup reports `UNSUPPORTED` because the pinned native flag would publish ports across the sandbox; this requires a separate product decision.

E2B requires explicit `e2b({ apiKey, preview: { access: "public" } })` for usable preview access. This exposes its HTTP services to anyone who can reach their URLs, beginning at creation/restore, before `preview()` runs. Lookup requires current public visibility and auto-resume off. Default/protected E2B creation and restore explicitly disable public traffic, but protected `preview()` reports `UNSUPPORTED`: the pinned read-only detail endpoint cannot return its traffic token, and Sandbar will not invoke native connect to retrieve one. This is a limitation in protected access, not an automatic fallback to public. Connecting does not change existing sandbox visibility.

URLs and headers are ephemeral credentials/access information. Do not log or store them as sandbox identity. Save the ordinary `box.reference` for reopening, then request access again. Sandbox deletion/expiry makes the service unavailable; no common URL expiry or revocation guarantee is promised. Response URLs must be HTTPS without userinfo/query/hash credentials. Sandbar excludes access results from diagnostics and recovery state.

The [compiled recipe](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-preview.ts) uses existing explicit environment setup and an image-owned server. It does not advertise the finite E2B stream as indefinite server logs. Deterministic native/API and packed consumer tests cover this slice; maintained live preview cases have not run. See [tested support](/docs/providers/support/).
