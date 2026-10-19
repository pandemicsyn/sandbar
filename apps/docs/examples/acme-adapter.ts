import { z } from "zod";
import {
  bindAdapter,
  defineAdapter,
  ResourceMinimums,
  smallestSize,
  type SandboxResources,
} from "@sandbar-sdk/adapter";
import { AcmeClient } from "./acme-native";

/** Acme sizes, smallest first. */
const SIZES = [
  { type: "small", vcpus: 1, memoryMiB: 2048 },
  { type: "medium", vcpus: 2, memoryMiB: 4096 },
  { type: "large", vcpus: 4, memoryMiB: 8192 },
] as const;

const Config = z.strictObject({
  region: z.string().min(1),
  /** Default image for creates that name none. */
  image: z.string().min(1).default("image-123"),
  /** Minimum size; the smallest Acme size that meets it is used. */
  resources: ResourceMinimums.optional(),
});

const Credentials = z.strictObject({ token: z.string().min(1) });

/** Copy this shape, then replace AcmeClient with an authenticated provider client. */
export const acmeAdapter = defineAdapter({
  name: "example.acme",
  displayName: "Acme fixture",
  config: Config,
  credentials: Credentials,
  async connect({ config, credentials, host }) {
    // Unmet minimums reject before any provider IO.
    const size = smallestSize("Acme", SIZES, config.resources ?? {});
    const client = new AcmeClient(credentials.token);
    host.onClose(() => client.close());
    const account = await client.whoami();

    const resources = (type: string): SandboxResources | undefined => {
      const match = SIZES.find((value) => value.type === type);

      return match && { vcpus: match.vcpus, memoryMiB: match.memoryMiB };
    };

    return {
      scope: {
        authority: { kind: "account", id: account.id },
        partition: { region: config.region },
      },
      defaultImage: { kind: "prepared", value: config.image },
      defaultNetworkPolicy: "blocked",
      supports: { images: ["prepared"], network: ["blocked"] },
      async create(input, ctx) {
        const box = await client.spawn({
          account: account.id,
          imageId: input.image.value,
          region: config.region,
          size: size.type,
          blockAllEgress: true,
          public: false,
          requestId: ctx.submissionId,
        });

        return { id: box.id, state: box.ready ? ("running" as const) : ("unknown" as const) };
      },
      async inspect(box) {
        const native = await client.get(box.id, account.id, config.region);

        if (!native) return null;
        const value = resources(native.size);

        return {
          id: native.id,
          state: native.running ? ("running" as const) : ("destroyed" as const),
          resources: value
            ? { status: "known" as const, value }
            : { status: "unknown" as const, reason: "Acme reported an unlisted size" },
        };
      },
      async destroy(box) {
        await client.deleteAndWait(box.id, account.id, config.region);

        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});

export type AcmeOptions = z.input<typeof Config> & z.input<typeof Credentials>;

/** Packages settings for `Sandbar.connect`; performs no provider IO. */
export function acme({ token, ...config }: AcmeOptions) {
  return bindAdapter(acmeAdapter, config, { token });
}
