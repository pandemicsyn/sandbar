---
"@sandbar-sdk/adapter": minor
"@sandbar-sdk/daytona": minor
"@sandbar-sdk/e2b": minor
"@sandbar-sdk/boxd": minor
"@sandbar-sdk/vercel": minor
---

Make every adapter's defaults work on first use, and match lifetime limits to each provider.

- Daytona now defaults to `network: "daytona-default"`, which every account tier can create. Strict `blocked` egress stays available when you select it. Connections that relied on the old implicit `blocked` default must set `network: "blocked"` to reopen sandboxes created that way.
- E2B and boxd now default to `preview.access: "public"`, matching each provider's native default, so `box.preview(port)` works without extra setup. Select `preview.access: "protected"` to keep sandboxes closed to inbound traffic.
- Vercel now defaults to the `vercel/sandbox/universal:latest` image, so processes and terminals work without extra setup. Set `image: "vercel/sandbox/node:24"` to keep using sandboxes and snapshots created with the previous default.
- Every adapter now defaults to a 15-minute sandbox lifetime. Daytona previously defaulted to 60 minutes; E2B and Vercel previously defaulted to 5 minutes.
- Lifetime and renewal limits now match the providers. E2B and Vercel accept up to 24 hours, their longest plan limit; each provider still enforces lower plan limits. Daytona and boxd no longer impose a maximum, because neither provider documents one.
- Renewal capabilities omit `maxSeconds` when the provider has no maximum.
