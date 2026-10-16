import { createE2BAdapter } from "./index";
import { bindAdapter, type BoundAdapter } from "@sandbar-sdk/adapter";

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
  lifecycle?: {
    lifetimeSeconds?: number;
    suspension?: { preserve: "filesystem" | "filesystem+memory" };
  };
}): BoundAdapter {
  return bindAdapter(
    createE2BAdapter(),
    {
      teamId: options.teamId,
      templateId: options.templateId,
      network: options.network,
      networkPolicy: options.networkPolicy,
      timeoutSeconds: options.timeoutSeconds,
      lifecycle: options.lifecycle,
      preview: options.preview,
    },
    { apiKey: options.apiKey },
  );
}
