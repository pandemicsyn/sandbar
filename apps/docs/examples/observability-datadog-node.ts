import tracer from "dd-trace";

tracer.init({ service: "sandbar-demo" });

const provider = new tracer.TracerProvider();

provider.register();

// Import the SDK after registering the application's existing Datadog tracer.
const { Sandbar, Image } = await import("sandbar-sdk");

const { daytona } = await import("sandbar-sdk/daytona");

const client = await Sandbar.connect(
  daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    target: process.env.DAYTONA_TARGET ?? "us",
    ttlMinutes: 15,
    networkPolicy: "daytona-default",
  }),
);

try {
  await tracer.trace("sandbar-demo", async () => {
    const box = await client.sandboxes.create({
      environment: Image.prepared("daytona-small"),
      networkPolicy: "daytona-default",
    });

    await box.destroy();
  });
} finally {
  await client.close();
}
