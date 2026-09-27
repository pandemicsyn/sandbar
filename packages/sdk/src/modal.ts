import { createModalAdapter } from "@sandbar/provider-modal";
import { bindAdapter, type BoundAdapter } from "./bound";

/** First-party Modal adapter bound to a named App and token. */
export function modal(options: {
  tokenId: string;
  tokenSecret: string;
  appName: string;
  environment: string;
  region?: string;
  timeoutSeconds?: number;
}): BoundAdapter {
  return bindAdapter(
    createModalAdapter(),
    {
      appName: options.appName,
      environment: options.environment,
      region: options.region,
      timeoutSeconds: options.timeoutSeconds,
    },
    { tokenId: options.tokenId, tokenSecret: options.tokenSecret },
  );
}
