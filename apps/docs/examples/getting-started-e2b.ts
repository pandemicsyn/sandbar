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
