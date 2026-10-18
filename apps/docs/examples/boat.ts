import { Sandbar } from "sandbar-sdk";
import { boatAdapter } from "@sandbar-sdk/boat";

export async function boatExample(apiKey: string) {
  const client = await Sandbar.connect({
    adapter: boatAdapter,
    credentials: { apiKey },
    config: { network: "internet" },
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
