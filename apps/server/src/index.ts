import { createApp } from "./app";

const app = createApp();
const port = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer from 0 to 65535");
}

export default { port, fetch: app.fetch };
