import { Image, Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

const apiKey = process.env.DAYTONA_API_KEY;

if (!apiKey) throw new Error("Set DAYTONA_API_KEY before running this example");

const sandbar = await Sandbar.connect(
  daytona({
    apiKey,
    target: "us",
    environment: Image.prepared("daytona-small"),
    ttlMinutes: 15,
    networkPolicy: "daytona-default",
  }),
);

try {
  const box = await sandbar.sandboxes.create({
    networkPolicy: "daytona-default",
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
