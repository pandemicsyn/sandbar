# E2B built-in adapter

Install `sandbar-sdk` and import the built-in subpath:

```ts
import { Sandbar, Image } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";

const client = await Sandbar.connect(
  e2b({
    apiKey: process.env.E2B_API_KEY!,
    teamId: process.env.E2B_TEAM_ID!,
    templateId: process.env.E2B_TEMPLATE_ID!,
  }),
);

const box = await client.sandboxes.create({
  environment: Image.prepared(process.env.E2B_TEMPLATE_ID!),
  networkPolicy: "blocked",
});

await box.writeFile("/tmp/data.bin", Uint8Array.from([0, 255, 129]), { overwrite: false });
const data = await box.readFile("/tmp/data.bin");
const result = await box.exec({ command: { kind: "argv", argv: ["wc", "-c", "/tmp/data.bin"] } });
await box.destroy();
await client.close();
```

The factory performs no provider IO. `Sandbar.connect` checks the team with an authenticated E2B team metrics read and checks that the configured team has a ready template. Each connection is confined to that team and template. The adapter uses only the public `sandbar-adapter` contract; the optional service registers the same definition explicitly and keeps the API key in its normal encrypted credential store.

Prepared images use the verified template ID. An OCI reference runs E2B's `Template().fromImage(reference)` build inside the create submission, then creates a sandbox from the ready E2B template. OCI builds are paid effects and retain the built template after sandbox destruction; the destroy result names it as a retained resource. Public registry images are the supported input; private registry credentials have no common Sandbar input yet. Network modes are `internet` and `blocked` through E2B's `allowInternetAccess` control. Region selection is unsupported. Command forms are argv and Bash shell, with cwd and environment. E2B's command API decodes process output as text, so the adapter redirects each stream to a sandbox file and reads the bytes through E2B's streaming file API. Combined stdout and stderr are capped at 1 MiB; file reads and writes are capped at 1 MiB. A no-clobber write uploads to a temporary file in the destination directory and links it to the destination atomically on the sandbox filesystem.

The pinned `e2b@2.51.0` SDK retries rate limited control requests by default. This adapter passes `retries: 0` for sandbox and build mutations. Creation embeds Sandbar submission and operation IDs in E2B metadata. After a lost create response, observation searches that metadata without creating another sandbox. OCI builds use a name derived from the submission ID. If a build succeeds but sandbox creation is not confirmed, observation reports the retained template and the original create remains unknown; reconnecting with that template ID and issuing a new prepared-image create is the recovery path. Exec completion is recorded in sandbox files for observation after a lost response. Other uncertain write and destroy outcomes remain unknown and are never replayed. Aborting local waits or closing the client does not terminate remote compute; destroy confirms absence before reporting `computeStopped`.

Deterministic fixtures and packed Node/Bun consumers qualify this integration. No live E2B account, paid sandbox or production network policy has been exercised.
