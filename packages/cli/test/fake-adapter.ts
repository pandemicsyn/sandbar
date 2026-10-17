import { bindAdapter } from "@sandbar-sdk/adapter";
import { createFakeAdapter } from "@sandbar/provider-fake";

const url = process.env.SANDBAR_FAKE_URL;

const token = process.env.SANDBAR_FAKE_TOKEN;

if (!url || !token) throw new Error("SANDBAR_FAKE_URL and SANDBAR_FAKE_TOKEN are required");

/** A bound fake adapter so CLI processes in tests reach the test's fake provider server. */
export const fake = bindAdapter(createFakeAdapter({ url, token }), {}, {});
