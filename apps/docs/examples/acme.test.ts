import { expect, test } from "bun:test";
import { Image, Sandbar } from "sandbar-sdk";
import { acme } from "./acme-adapter";
import { AcmeClient } from "./acme-native";

test("copyable Acme adapter uses the SDK without a service or database", async () => {
  const before = {
    creates: AcmeClient.creates,
    destroys: AcmeClient.destroys,
    closes: AcmeClient.closes,
  };

  const sandbar = await Sandbar.connect({
    adapter: acme,
    config: { region: "us" },
    credentials: { token: "fixture-token" },
  });

  try {
    const box = await sandbar.sandboxes.create({ environment: Image.prepared("image-123") });
    expect(box.id).toStartWith("acme-");
    await box.destroy();
  } finally {
    await sandbar.close();
  }

  expect(AcmeClient.creates).toBe(before.creates + 1);
  expect(AcmeClient.destroys).toBe(before.destroys + 1);
  expect(AcmeClient.closes).toBe(before.closes + 1);
});
