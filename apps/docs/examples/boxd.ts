import { Sandbar } from "sandbar-sdk";
import { boxdAdapter } from "sandbar-boxd";

export async function boxdExample(apiKey: string, org: string) {
  const client = await Sandbar.connect({
    adapter: boxdAdapter,
    credentials: { apiKey },
    config: { org, networkPolicy: "internet" },
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
