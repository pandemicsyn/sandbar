import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { AcmeClient } from "./acme-native";

/** Copy this shape, then replace AcmeClient with an authenticated provider client. */
export const acme = defineAdapter({
  name: "example.acme",
  displayName: "Acme fixture",
  config: z.strictObject({ region: z.string().min(1) }),
  credentials: z.strictObject({ token: z.string().min(1) }),
  async connect({ config, credentials, host }) {
    const client = new AcmeClient(credentials.token);
    host.onClose(() => client.close());
    const account = await client.whoami();

    return {
      scope: {
        authority: { kind: "account", id: account.id },
        partition: { region: config.region },
      },
      supports: { images: ["prepared"], network: ["blocked"] },
      async create(input, ctx) {
        const box = await client.spawn({
          account: account.id,
          imageId: input.image.value,
          region: config.region,
          blockAllEgress: true,
          public: false,
          requestId: ctx.submissionId,
        });

        return { id: box.id, state: box.ready ? ("running" as const) : ("unknown" as const) };
      },
      async destroy(box) {
        await client.deleteAndWait(box.id, account.id, config.region);

        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});
