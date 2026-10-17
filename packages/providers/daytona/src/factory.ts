import { createDaytonaAdapter } from "./index";
import type { ImageInput } from "@sandbar-sdk/adapter";
import { bindAdapter, type BoundAdapter } from "@sandbar-sdk/adapter";

/** First-party Daytona adapter. Select daytona-default explicitly on connection and create for provider-managed egress. */
export function daytona(options: {
  apiKey: string;
  target: string;
  environment?: ImageInput;
  ttlMinutes?: number;
  preview?: { access: "protected" | "public" };
  lifecycle?: {
    lifetimeSeconds?: number;
    /** Stop the sandbox after this many idle seconds, rounded up to minutes. Omit to keep it running until its lifetime ends. */
    idleSeconds?: number;
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
