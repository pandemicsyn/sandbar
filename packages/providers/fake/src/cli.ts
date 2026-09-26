import { startFakeProviderServer } from "./server";

if (process.env.SANDBAR_ENABLE_FAKE_PROVIDER !== "1") throw new Error("Set SANDBAR_ENABLE_FAKE_PROVIDER=1 to run the clearly simulated fake provider");
const statePath = process.env.SANDBAR_FAKE_STATE_PATH;
const token = process.env.SANDBAR_FAKE_TOKEN;
if (!statePath || !token) throw new Error("SANDBAR_FAKE_STATE_PATH and SANDBAR_FAKE_TOKEN are required");
const server = await startFakeProviderServer({ hostname: "127.0.0.1", port: Number(process.env.SANDBAR_FAKE_PORT ?? 8789), statePath, token, testMode: process.env.SANDBAR_FAKE_TEST_MODE === "1" });
console.log(`FAKE SANDBOX PROVIDER (simulation) listening on ${server.url}`);
