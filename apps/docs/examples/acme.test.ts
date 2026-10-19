import { expect, test } from "bun:test";
import { Image, Sandbar } from "sandbar-sdk";
import { acme, acmeAdapter } from "./acme-adapter";
import { AcmeClient } from "./acme-native";

test("copyable Acme adapter uses the SDK", async () => {
  const before = {
    creates: AcmeClient.creates,
    destroys: AcmeClient.destroys,
    closes: AcmeClient.closes,
  };

  const sandbar = await Sandbar.connect({
    adapter: acmeAdapter,
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

test("Acme factory applies setup defaults and resource minimums", async () => {
  const sandbar = await Sandbar.connect(
    acme({ token: "fixture-token", region: "us", resources: { memoryMiB: 3000 } }),
  );

  try {
    const box = await sandbar.sandboxes.create({});
    const info = await box.inspect();
    expect(info.resources).toEqual({ status: "known", value: { vcpus: 2, memoryMiB: 4096 } });
    await box.destroy();
  } finally {
    await sandbar.close();
  }
});

test("Acme rejects unmet minimums before provider IO", async () => {
  const closes = AcmeClient.closes;

  await expect(
    Sandbar.connect(acme({ token: "fixture-token", region: "us", resources: { vcpus: 64 } })),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  // No native client was constructed, so none was closed.
  expect(AcmeClient.closes).toBe(closes);
});
