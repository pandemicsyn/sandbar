# Sandbar

**[Read the docs →](https://sandbarsdk.dev/docs/)**

Sandbar is a TypeScript SDK for creating sandboxes, running commands, and moving files across providers. Daytona and E2B are built in; custom providers use the same adapter API. Run it in Node.js or Bun, with an optional service for shared infrastructure.

Create a sandbox, run a command, and clean up:

```ts
import { Image, Sandbar } from "sandbar-sdk";
import { e2b } from "sandbar-sdk/e2b";

const apiKey = process.env.E2B_API_KEY;

if (!apiKey) throw new Error("Set E2B_API_KEY before running this example");

const sandbar = await Sandbar.connect(e2b({ apiKey }));

try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared("base"),
    networkPolicy: "blocked",
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

Set `E2B_API_KEY` to use this example. Packages are not published yet; see [Getting started](https://sandbarsdk.dev/docs/direct-quickstart/) for setup and provider examples.

[Provider support](https://sandbarsdk.dev/docs/providers/support/) · [API reference](https://sandbarsdk.dev/docs/reference/typescript/) · [License](LICENSE)
