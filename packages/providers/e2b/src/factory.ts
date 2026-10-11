import { createE2BAdapter } from "./index";
import { bindAdapter, type BoundAdapter } from "sandbar-adapter";

/** E2B adapter with API-key scope and default base template; optional verified team scope. */
export function e2b(options: {
  apiKey: string;
  teamId?: string;
  templateId?: string;
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
      timeoutSeconds: options.timeoutSeconds,
      lifecycle: options.lifecycle,
      preview: options.preview,
    },
    { apiKey: options.apiKey },
  );
}
