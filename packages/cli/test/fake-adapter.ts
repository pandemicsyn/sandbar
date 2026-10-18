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

/** The fake adapter without create-time env, like a provider that cannot guarantee it. */
export const withoutCreateEnv = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider without create env",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const session = await definition.connect({ config: {}, credentials: {}, host });

      return { ...session, supports: { ...session.supports, createEnv: false } };
    },
  }),
  {},
  {},
);

/** The fake adapter without image inspection, inventory or deletion, like boxd or Vercel. */
export const plain = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider without image management",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const {
        imageInspect: _inspect,
        imageList: _list,
        imageListCoverage: _coverage,
        imageDelete: _delete,
        ...session
      } = await definition.connect({ config: {}, credentials: {}, host });

      return session;
    },
  }),
  {},
  {},
);

const builds = process.env.SANDBAR_FAKE_BUILDS;

const building = createFakeAdapter({ url, token, imageBuild: true });

/**
 * The fake adapter with its simulated image build, standing in for build-first providers such as
 * E2B. Each build is a new fake image; a `lost/` reference loses the build and delete responses.
 * SANDBAR_FAKE_BUILDS logs every submitted build.
 */
export const builder = bindAdapter(
  defineAdapter({
    name: "fake",
    displayName: "Fake test provider that builds images",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      const session = await building.connect({ config: {}, credentials: {}, host });
      const build = session.imageBuild;

      if (!build || !("submit" in build)) throw new Error("The fake must build images");

      return {
        ...session,
        imageBuild: {
          ...build,
          async submit(input, ctx) {
            if (builds) await appendFile(builds, `${input.source.value}\n`);

            return build.submit(input, ctx);
          },
        },
      };
    },
  }),
  {},
  {},
);
