import { createDaytonaAdapter } from "./index";
import type { ImageInput, ResourceMinimums } from "@sandbar-sdk/adapter";
import { bindAdapter, type BoundAdapter } from "@sandbar-sdk/adapter";

/** First-party Daytona adapter. Configure `network` once here; omitted create calls use it. Defaults to provider-managed daytona-default egress. */
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
  /** Minimum `{ vcpus, memoryMiB }`; OCI builds use it and prepared snapshots must meet it. */
  resources?: ResourceMinimums;
  /** Outbound network: `blocked`, `internet`, or Daytona's tier-dependent `daytona-default` (default). */
  network?: "blocked" | "internet" | "daytona-default";
  /** @deprecated Use `network`. */
  networkPolicy?: "blocked" | "internet" | "daytona-default";
}): BoundAdapter {
  const config = {
    target: options.target,
    environment: options.environment,
    ttlMinutes: options.ttlMinutes,
    lifecycle: options.lifecycle,
    preview: options.preview,
    snapshots: options.snapshots,
    resources: options.resources,
    network: options.network,
    networkPolicy: options.networkPolicy,
  };

  return bindAdapter(createDaytonaAdapter(), config, { apiKey: options.apiKey });
}
