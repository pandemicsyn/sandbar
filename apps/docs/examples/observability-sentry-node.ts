import * as Sentry from "@sentry/node";
import { Sandbar, Image } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";

Sentry.init({
  dsn: process.env.SENTRY_DSN!,
  tracesSampleRate: 1,
  enableOpenTelemetrySetup: true,
});

try {
  const client = await Sandbar.connect(
    daytona({
      apiKey: process.env.DAYTONA_API_KEY!,
      target: process.env.DAYTONA_TARGET ?? "us",
      ttlMinutes: 15,
      networkPolicy: "daytona-default",
    }),
  );

  try {
    await Sentry.startSpan({ name: "sandbar-demo" }, async () => {
      const box = await client.sandboxes.create({
        environment: Image.prepared("daytona-small"),
        networkPolicy: "daytona-default",
      });

      await box.destroy();
    });
  } finally {
    await client.close();
  }
} finally {
  await Sentry.close(2000);
}
