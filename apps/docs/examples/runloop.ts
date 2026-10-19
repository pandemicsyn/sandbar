import { Sandbar } from "sandbar-sdk";
import { runloopAdapter } from "@sandbar-sdk/runloop";

export async function runloopExample(apiKey: string) {
  const client = await Sandbar.connect({
    adapter: runloopAdapter,
    credentials: { apiKey },
    config: { network: "blocked" },
  });

  try {
    const box = await client.sandboxes.create();

    try {
      return (await box.exec(["/bin/sh", "-c", "printf ready"])).stdoutText();
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
}
