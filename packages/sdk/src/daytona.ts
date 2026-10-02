import { createDaytonaAdapter } from "@sandbar/provider-daytona";
import type { ImageInput } from "./resource";
import { bindAdapter, type BoundAdapter } from "./bound";

/** First-party Daytona adapter. Select daytona-default explicitly on connection and create for provider-managed egress. */
export function daytona(options: {
  apiKey: string;
  target: string;
  environment?: ImageInput;
  ttlMinutes?: number;
  preview?: { access: "protected" | "public" };
  lifecycle?: {
    lifetimeSeconds?: number;
    suspension?: { preserve: "filesystem" | "filesystem+memory" };
  };
  snapshots?: { restartAfterCapture?: boolean };
  networkPolicy?: "blocked" | "daytona-default";
}): BoundAdapter {
  const config = {
    target: options.target,
    environment: options.environment,
    ttlMinutes: options.ttlMinutes,
    lifecycle: options.lifecycle,
    preview: options.preview,
    snapshots: options.snapshots,
    networkPolicy: options.networkPolicy,
  };

  return bindAdapter(createDaytonaAdapter(), config, { apiKey: options.apiKey });
}
