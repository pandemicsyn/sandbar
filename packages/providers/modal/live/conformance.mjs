import { Sandbar, Image } from "sandbar-sdk/direct";
import { modalProvider } from "../dist/index.js";

function required(name) {
  const value = process.env[name];

  if (!value)
    throw new Error(`${name} is required for an explicitly authorized live conformance run`);

  return value;
}

if (process.env.SANDBAR_MODAL_LIVE !== "1") throw new Error("Set SANDBAR_MODAL_LIVE=1 to opt in");

if (process.env.SANDBAR_MODAL_BUDGET_ACK !== "one sandbox, at most 300 seconds")
  throw new Error("Acknowledge the one-sandbox, 300-second native timeout budget");

const provider = await modalProvider({
  tokenId: required("MODAL_TOKEN_ID"),
  tokenSecret: required("MODAL_TOKEN_SECRET"),
  appName: required("SANDBAR_MODAL_APP"),
  environment: required("SANDBAR_MODAL_ENVIRONMENT"),
  region: required("SANDBAR_MODAL_REGION"),
  timeoutSeconds: 300,
});

const client = Sandbar.direct({ provider });

let box;

try {
  box = await client.sandboxes.create({
    environment: Image.prepared(required("SANDBAR_MODAL_IMAGE_ID")),
    region: required("SANDBAR_MODAL_REGION"),
    networkPolicy: "blocked",
  });
  const observation = await box.inspect();

  if (observation.state !== "running") throw new Error(`Unexpected state: ${observation.state}`);
  console.log(JSON.stringify({ sandboxId: box.id, observation }));
} finally {
  try {
    if (box) await box.destroy();
  } finally {
    await client.close();
  }
}
