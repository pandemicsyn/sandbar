---
title: Preview access
description: Access an HTTP service running inside a sandbox.
---

Use `await box.preview(3000)` to get access to an HTTP service on port 3000 inside a running sandbox. Choose public or protected access when configuring the adapter. The available modes depend on the provider.

This example uses Daytona's default protected access. Replace `existing-server-snapshot` with a prepared image whose startup configuration launches an HTTP server on port 3000:

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { daytona } from "@sandbar-sdk/daytona";

const client = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: "us",
    networkPolicy: "daytona-default",
    preview: { access: "protected" }, // default
  }),
);
try {
  const box = await client.sandboxes.create({
    environment: Image.prepared("existing-server-snapshot"),
  });
  try {
    const preview = await box.preview(3000);
    const response = await fetch(preview.url, {
      headers: preview.access === "protected" ? preview.headers : undefined,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Service unavailable or not ready");
    console.log(await response.text());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

## Service readiness and cancellation

`preview()` does not start a server or wait for it to be ready. Start your service through the image's startup configuration or the [process API](/docs/guides/text-streaming/). A preview URL can be available before the service starts listening, so handle failed HTTP requests and check readiness in your application.

Preview lookup also does not resume a suspended sandbox, extend its lifetime, replace it, or change its outbound network policy. Outbound network policy and inbound preview access are separate settings.

Ports must be integers from **1 through 65535**. Lookup has a **30-second deadline**. Pass `preview(port, { signal })` to cancel local waiting. Cancellation does not stop the remote service, and the signal does not apply to later `fetch()` calls; pass a signal to those separately if needed.

## Protected access with Daytona

A protected result contains `url` and `headers`. Send those headers from your own HTTP client, as shown above. Merely opening the URL in a browser does not supply them.

**Daytona's preview token grants access across the sandbox, including terminal/toolbox command execution and filesystem access.** Treat it as a sandbox credential. Do not share it as a read-only viewing link or expose it to an untrusted client.

Requests carrying preview headers must use `redirect: "error"`. Otherwise, a redirect to a different host can forward custom authentication headers and disclose the token.

Daytona's standard tokens cannot be revoked individually. Native stop/start rotates them; native pause/resume retains them. Looking up access can activate the requested preview route. Sandbar verifies the sandbox's identity, running state and private visibility first, and does not change visibility during lookup.

Daytona public access reports `UNSUPPORTED`: the native setting would publish ports across the sandbox. The adapter currently supports protected access only.

## Public access with E2B

E2B preview access requires an explicit public setting:

```ts
import { e2b } from "@sandbar-sdk/e2b";

const setup = e2b({
  apiKey: process.env.E2B_API_KEY!,
  preview: { access: "public" },
});
```

Pass `setup` to `Sandbar.connect()`.

This setting exposes the sandbox's HTTP services to anyone who can reach their URLs. Exposure begins when a sandbox is created or restored, before you call `preview()`. Lookup requires confirmed public visibility, the native `e2b.app` domain and auto-resume disabled. Connecting alone does not change the visibility of existing sandboxes.

E2B creation and restore default to protected access: they disable public traffic and verify visibility before reporting success. If visibility cannot be confirmed, the operation remains uncertain and retains its confirmed resource identity for recovery and cleanup. Live tests have not yet qualified denial of incoming traffic under this private default.

Protected `preview()` reports `UNSUPPORTED` because the native read-only detail API used by the adapter cannot return the required token. Sandbar does not call E2B's native connect method to retrieve one, because that method can resume compute. It does not fall back to public access.

Recovery preserves an operation's original visibility setting. Older create references without preview metadata, and version-1 restore references without a visibility field, used public access. Recovering those operations requires confirmed native public visibility, even if the current connection defaults to protected access.

## Reuse sandbox identity, not access details

URLs and headers are temporary access information. Do not log them or use them as a saved sandbox identity. Save `box.reference` for reopening, then request preview access again. Sandbox deletion or expiry makes the service unavailable; Sandbar does not promise a shared URL expiry or revocation policy across providers.

Sandbar validates that response URLs use HTTPS and contain no username, password, query or fragment. It excludes returned access details from diagnostics and recovery state.

The complete [preview recipe](https://github.com/pandemicsyn/sandbar/blob/main/apps/docs/examples/sandbox-preview.ts) uses an image that starts its own server. Offline tests cover the SDK and provider boundaries. Daytona protected access and E2B explicit public access passed live tests at `3188e33`, with sandbox cleanup confirmed. See [tested provider support](/docs/providers/support/) for the exact scope and remaining gaps.
