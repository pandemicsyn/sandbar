import { createDaytonaAdapter } from "@sandbar/provider-daytona";
import { bindAdapter, type BoundAdapter } from "./bound";

/** First-party Daytona adapter. Select daytona-default explicitly on connection and create for provider-managed egress. */
export function daytona(options: {
  apiKey: string;
  target: string;
  ttlMinutes?: number;
  networkPolicy?: "blocked" | "daytona-default";
}): BoundAdapter {
  const config = {
    target: options.target,
    ttlMinutes: options.ttlMinutes,
    networkPolicy: options.networkPolicy,
  };

  return bindAdapter(createDaytonaAdapter(), config, { apiKey: options.apiKey });
}
