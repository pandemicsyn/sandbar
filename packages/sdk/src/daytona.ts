import { createDaytonaAdapter } from "@sandbar/provider-daytona";
import { bindAdapter, type BoundAdapter } from "./bound";

/** First-party Daytona adapter. Select daytona-default explicitly on connection and create for provider-managed egress. */
export function daytona(options: {
  apiKey: string;
  target: string;
  ttlMinutes?: number;
  lifecycle?: { lifetimeSeconds?: number };
  snapshots?: { restartAfterCapture?: boolean };
  networkPolicy?: "blocked" | "daytona-default";
}): BoundAdapter {
  const config = {
    target: options.target,
    ttlMinutes: options.ttlMinutes,
    lifecycle: options.lifecycle,
    snapshots: options.snapshots,
    networkPolicy: options.networkPolicy,
  };

  return bindAdapter(createDaytonaAdapter(), config, { apiKey: options.apiKey });
}
