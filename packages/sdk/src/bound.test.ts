import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Sandbar, Image } from "./index";
import { bindAdapter } from "./bound";

test("bound first-party factory uses the public connection validation and lifetime", async () => {
  let connects = 0;
  let releases = 0;

  const definition = defineAdapter({
    name: "example.bound",
    config: z.strictObject({ target: z.string().min(1) }),
    credentials: z.strictObject({ token: z.string().min(1) }),
    async connect({ config, credentials, host }) {
      connects++;
      expect(config.target).toBe("us");
      expect(credentials.token).toBe("secret");
      host.onClose(() => {
        releases++;
      });

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: { target: config.target } },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "native-1", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const bound = bindAdapter(definition, { target: "us" }, { token: "secret" });
  expect(connects).toBe(0);

  const client = await Sandbar.connect(bound);

  try {
    expect(connects).toBe(1);
    expect(client.scope.partition.target).toBe("us");
    const box = await client.sandboxes.create({ environment: Image.prepared("image-1") });
    expect(box.id).toBe("native-1");
    await box.destroy();
  } finally {
    await client.close();
  }

  expect(releases).toBe(1);
});
