import { createDaytonaAdapter } from "@sandbar/provider-daytona";
import { bindAdapter, type BoundAdapter } from "./bound";

/** First-party Daytona adapter bound to a target and API key. */
export function daytona(options: {
  apiKey: string;
  target: string;
  ttlMinutes?: number;
}): BoundAdapter {
  const config = { target: options.target, ttlMinutes: options.ttlMinutes };

  return bindAdapter(createDaytonaAdapter(), config, { apiKey: options.apiKey });
}
