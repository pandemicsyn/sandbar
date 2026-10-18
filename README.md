# Sandbar

**[Read the docs →](https://sandbarsdk.dev/docs/)**

Sandbar is a TypeScript SDK for creating sandboxes, running commands, and moving files across providers. Daytona, E2B, boxd, Boat and Vercel are separately installed adapters; custom providers use the same adapter API. Run it in Node.js or Bun.

Create a sandbox, run a command, and clean up:

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { e2b } from "@sandbar-sdk/e2b";

const apiKey = process.env.E2B_API_KEY;

if (!apiKey) throw new Error("Set E2B_API_KEY before running this example");

const sandbar = await Sandbar.connect(e2b({ apiKey }));

try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared("base"),
    network: "blocked",
  });

  try {
    const output = await box.exec(["printf", "Hello from Sandbar!\n"]);
    console.log(output.stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
```

Install with `npm install sandbar-sdk @sandbar-sdk/e2b` and set `E2B_API_KEY` to run this example. See [Getting started](https://sandbarsdk.dev/docs/direct-quickstart/) for other providers.

Using a coding agent? `npx skills add pandemicsyn/sandbar --skill sandbar -g` teaches it the SDK; see [Agent skills](https://sandbarsdk.dev/docs/agents/skills/).

[Vercel setup and limits](https://sandbarsdk.dev/docs/providers/vercel/) · [Provider support](https://sandbarsdk.dev/docs/providers/support/) · [API reference](https://sandbarsdk.dev/docs/reference/typescript/) · [Roadmap](ROADMAP.md) · [License](LICENSE)

Repository validation and release rehearsal coverage are documented in [CI.md](CI.md).
