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
