import { appendFile } from "node:fs/promises";
import { bindAdapter, defineAdapter } from "@sandbar-sdk/adapter";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { z } from "zod";

const url = process.env.SANDBAR_FAKE_URL;

const token = process.env.SANDBAR_FAKE_TOKEN;

if (!url || !token) throw new Error("SANDBAR_FAKE_URL and SANDBAR_FAKE_TOKEN are required");

const definition = createFakeAdapter({ url, token });

/** A bound fake adapter so CLI processes in tests reach the test's fake provider server. */
export const fake = bindAdapter(definition, {}, {});

/** The fake adapter behind a token credential, to prove how the CLI resolves credentials. */
export const guarded = defineAdapter({
  name: "fake",
  displayName: "Fake test provider with a token",
  config: z.strictObject({}),
  credentials: z.strictObject({ token: z.string() }),
  async connect({ credentials, host }) {
    if (credentials.token !== token) throw new Error(`wrong token ${credentials.token}`);

    return definition.connect({ config: {}, credentials: {}, host });
  },
});

const builds = process.env.SANDBAR_FAKE_BUILDS;

const built = {
  preparedId: "fake-starter",
  retainedResources: [
    {
      kind: "fake-image",
      id: "fake-starter",
      ownership: "verified" as const,
      cleanup: "manual" as const,
    },
  ],
};

/**
 * The fake adapter with an image build, standing in for build-first providers such as E2B. Every
 * build lands on fake-starter; a `lost/` reference loses the build's response.
 */
export const builder = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider that builds images",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const session = await definition.connect({ config: {}, credentials: {}, host });

      return {
        ...session,
        imageBuild: {
          async submit(input, ctx) {
            if (builds) await appendFile(builds, `${input.source.value}\n`);

            if (input.source.value.startsWith("lost/"))
              return ctx.unknown("The fake lost the build response");

            return built;
          },
          async observe() {
            return built;
          },
        },
      };
    },
  }),
  {},
  {},
);
