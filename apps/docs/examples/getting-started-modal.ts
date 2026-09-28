import { Image, Sandbar } from "sandbar-sdk";
import { modalAdapter } from "sandbar-modal";

const tokenId = process.env.MODAL_TOKEN_ID;

const tokenSecret = process.env.MODAL_TOKEN_SECRET;

const appName = process.env.MODAL_APP_NAME;

const imageId = process.env.MODAL_IMAGE_ID;

if (!tokenId || !tokenSecret || !appName || !imageId)
  throw new Error("Set MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, MODAL_APP_NAME, and MODAL_IMAGE_ID");

const sandbar = await Sandbar.connect({
  adapter: modalAdapter,
  config: { appName, environment: "main", timeoutSeconds: 300 },
  credentials: { tokenId, tokenSecret },
});

try {
  const box = await sandbar.sandboxes.create({
    environment: Image.prepared(imageId),
    networkPolicy: "blocked",
  });

  try {
    const output = await box.exec(["/bin/sh", "-c", "printf 'Hello from Sandbar!\n'"]);
    console.log(output.stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await sandbar.close();
}
