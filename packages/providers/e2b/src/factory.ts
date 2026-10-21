import { createE2BAdapter } from "./index";
import {
  bindAdapter,
  type BoundAdapter,
  type Preserve,
  type ResourceMinimums,
} from "@sandbar-sdk/adapter";

/** E2B adapter with API-key scope and default base template; optional verified team scope. */
export function e2b(options: {
  apiKey: string;
  teamId?: string;
  templateId?: string;
  /** Outbound network: `blocked` (default) or `internet`. */
  network?: "blocked" | "internet";
  /** @deprecated Use `network`. */
  networkPolicy?: "blocked" | "internet";
  timeoutSeconds?: number;
  preview?: { access: "protected" | "public" };
  /** `Preserve.FILESYSTEM` captures disk only; the default also captures memory. */
  snapshots?: { preserve: Preserve };
  lifecycle?: {
    lifetimeSeconds?: number;
    /** `Preserve.FILESYSTEM` pauses disk only; the default also keeps memory. */
    suspension?: { preserve: Preserve };
  };
  /** Minimum `{ vcpus, memoryMiB }`; OCI builds use it and prepared templates must meet it. */
  resources?: ResourceMinimums;
}): BoundAdapter {
  return bindAdapter(
    createE2BAdapter(),
    {
      teamId: options.teamId,
      templateId: options.templateId,
      network: options.network,
      networkPolicy: options.networkPolicy,
      timeoutSeconds: options.timeoutSeconds,
      snapshots: options.snapshots,
      lifecycle: options.lifecycle,
      preview: options.preview,
      resources: options.resources,
    },
    { apiKey: options.apiKey },
  );
}
