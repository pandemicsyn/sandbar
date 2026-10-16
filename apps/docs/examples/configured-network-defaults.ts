import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "@sandbar-sdk/daytona";
import { e2b } from "@sandbar-sdk/e2b";

/** Caller supplies a ready Daytona image and explicitly chooses provider networking. */
export async function configuredWorkflow(
  provider: "daytona" | "e2b",
  apiKey: string,
  image: string,
) {
  const adapter =
    provider === "daytona"
      ? daytona({
          apiKey,
          target: "us",
          environment: Image.prepared(image),
          network: "daytona-default",
        })
      : e2b({ apiKey, templateId: "base", network: "internet" });

  const client = await Sandbar.connect(adapter);

  try {
    const box = await client.sandboxes.create();

    try {
      const { snapshot } = await box.snapshot();

      try {
        const restored = await snapshot.restore();

        try {
          await restored.exec(["printf", "ready"]);
        } finally {
          await restored.destroy();
        }
      } finally {
        await snapshot.delete();
      }
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
}
