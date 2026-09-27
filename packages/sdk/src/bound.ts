import { type AdapterDefinition, type HostContext, type RuntimeSession } from "sandbar-adapter";
import { z } from "zod";

const Empty = z.strictObject({});

export type BoundAdapter = AdapterDefinition<typeof Empty, typeof Empty, RuntimeSession> & {
  readonly bound: true;
};

/** Bind first-party provider settings while retaining the public adapter connection lifecycle. */
export function bindAdapter<C extends z.ZodType, K extends z.ZodType, S extends RuntimeSession>(
  definition: AdapterDefinition<C, K, S>,
  config: z.input<C>,
  credentials: z.input<K>,
): BoundAdapter {
  const bound = {
    name: definition.name,
    displayName: definition.displayName,
    config: Empty,
    credentials: Empty,
    async connect({ host }: { host: HostContext }) {
      return definition.connect({
        config: definition.config.parse(config),
        credentials: definition.credentials.parse(credentials),
        host,
      });
    },
  };

  return Object.freeze({ ...bound, bound: true as const });
}
